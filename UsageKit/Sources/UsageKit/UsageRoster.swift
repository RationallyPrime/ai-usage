import Foundation

/// Manual subscription topology. Each subscription has one quota collector;
/// shared seats reference that same reading instead of duplicating its state.
public struct UsageSubscription: Sendable, Equatable {
    public let provider: UsageProviderKind
    public let plan: String
    public let host: String
    public let profileID: String
    public let members: [String]
}

public struct UsageSeat: Sendable, Equatable, Identifiable {
    public let name: String
    public let subscription: UsageSubscription
    public var id: String { name }

    public var locationSummary: String {
        let others = subscription.members.filter { $0 != name }
        return others.isEmpty
            ? subscription.host
            : "\(subscription.host) · shared with \(others.joined(separator: ", "))"
    }

    public func pool(in snapshot: UsageSnapshot?) -> UsagePool? {
        snapshot?.pools.filter { pool in
            pool.provider == subscription.provider && pool.profiles.contains {
                $0.id == subscription.profileID
            }
        }.max { lhs, rhs in
            let left = lhs.profiles.first { $0.id == subscription.profileID }!.lastSeenAt
            let right = rhs.profiles.first { $0.id == subscription.profileID }!.lastSeenAt
            return left == right ? lhs.sampledAt < rhs.sampledAt : left < right
        }
    }
}

public enum UsageRoster {
    // Gnomon is the quota observer for the shared cx53 Claude subscription.
    // Ariadne deliberately observes the always-on cloud profile, never the Mac.
    public static let subscriptions: [UsageSubscription] = [
        .init(provider: .claude, plan: "Claude · Personal Max 20x", host: "Pop!_OS laptop",
              profileID: "fable-linux", members: ["Fable"]),
        .init(provider: .claude, plan: "Claude · Personal Max 20x", host: "cx53",
              profileID: "gnomon-cx53", members: ["Gnomon", "Theoros"]),
        .init(provider: .codex, plan: "Codex · Pro", host: "cx53",
              profileID: "ariadne-codex-cx53", members: ["Ariadne"]),
        .init(provider: .grok, plan: "Grok · SuperGrok Heavy", host: "cx43",
              profileID: "talos-cx43", members: ["Talos"]),
    ]

    public static let seats: [UsageSeat] = subscriptions.flatMap { subscription in
        subscription.members.map { UsageSeat(name: $0, subscription: subscription) }
    }
}
