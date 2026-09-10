import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

@Test func fixedRosterAlwaysHasExactlyFiveSeatsAndFourSubscriptions() {
    #expect(UsageRoster.seats.map(\.name) == ["Fable", "Gnomon", "Theoros", "Ariadne", "Talos"])
    #expect(UsageRoster.subscriptions.count == 4)
    #expect(UsageRoster.seats.allSatisfy { $0.pool(in: nil) == nil })
    let empty = UsageSnapshot(generatedAt: now, pools: [])
    #expect(UsageRoster.seats.allSatisfy { $0.pool(in: empty) == nil })
}

@Test func sharedSeatsUseOneReadingAndRetiredRowsNeverAppear() {
    let shared = testPool(id: "shared", sampledAt: now, profiles: [
        testProfile(id: "gnomon-cx53", now: now)
    ])
    let fable = testPool(id: "fable", sampledAt: now, profiles: [
        testProfile(id: "fable-linux", now: now)
    ])
    let oldFable = testPool(id: "old-fable", sampledAt: now, profiles: [
        testProfile(id: "fable-linux", now: now.addingTimeInterval(-86400))
    ])
    let oldMac = testPool(id: "mac", provider: .codex, sampledAt: now, profiles: [
        testProfile(id: "ariadne-codex-mac", now: now)
    ])
    let historical = (0..<20).map { testPool(id: "retired-\($0)", sampledAt: now) }
    let source = UsageSnapshot(generatedAt: now, pools: [oldFable, oldMac, shared, fable] + historical)
    #expect(UsageRoster.seats.map { $0.pool(in: source)?.id } == ["fable", "shared", "shared", nil, nil])
    #expect(UsageRoster.seats[1].locationSummary == "cx53 · shared with Theoros")
    #expect(UsageRoster.seats[2].locationSummary == "cx53 · shared with Gnomon")
}

@Test func cloudCodexRemainsSelectedWhenMacSampleIsNewer() {
    let cloud = testPool(id: "cloud", provider: .codex, sampledAt: now, profiles: [
        testProfile(id: "ariadne-codex-cx53", now: now)
    ])
    let mac = testPool(id: "mac", provider: .codex, sampledAt: now.addingTimeInterval(60), profiles: [
        testProfile(id: "ariadne-codex-mac", now: now.addingTimeInterval(60))
    ])
    let source = UsageSnapshot(generatedAt: now, pools: [mac, cloud])
    #expect(UsageRoster.seats[3].pool(in: source)?.id == "cloud")
}

@Test func poolExposesBothCurrentProfilesWithoutCollapsingThem() {
    let profiles = [
        testProfile(id: "desktop-a", label: "Desktop A", now: now),
        testProfile(id: "edge-profile-b", label: "Edge profile B", now: now),
        testProfile(id: "old", label: "Old observer", now: now, state: .recent),
    ]
    let pool = testPool(sampledAt: now, profiles: profiles)

    #expect(pool.currentProfiles(now: now).map(\.label) == ["Desktop A", "Edge profile B"])
    #expect(pool.profilesForDisplay(now: now).map(\.label) == ["Desktop A", "Edge profile B"])
}

@Test func poolKeepsKnownProfilesVisibleWhenNoneAreCurrent() {
    let profiles = [
        testProfile(id: "recent", label: "Recently observed", now: now, state: .recent),
        testProfile(id: "stale", label: "Known profile", now: now, state: .stale),
    ]
    let pool = testPool(sampledAt: now, profiles: profiles)

    #expect(pool.currentProfiles(now: now).isEmpty)
    #expect(pool.profilesForDisplay(now: now).map(\.label) == ["Recently observed", "Known profile"])
}
