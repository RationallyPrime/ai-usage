import SwiftUI
import UsageKit
import UsageUI
import WidgetKit

struct UsageEntry: TimelineEntry {
    let date: Date
    let snapshot: UsageSnapshot?
}

struct UsageTimelineProvider: TimelineProvider {
    private let store = try? UsageStore.shared()

    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), snapshot: .sample(now: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        let now = Date()
        // The gallery preview must never depend on the private feed being up.
        guard !context.isPreview else {
            completion(UsageEntry(date: now, snapshot: .sample(now: now)))
            return
        }
        Task {
            completion(UsageEntry(date: now, snapshot: await load()))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = UsageEntry(date: now, snapshot: await load())
            // This is a request, not a guarantee; WidgetKit may coalesce it.
            let next = now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    /// Never throws: an unreachable aggregator falls back to the cached
    /// snapshot, which the tiles then render with an honest age.
    private func load() async -> UsageSnapshot? {
        guard let store else { return nil }
        return await store.refreshConfigured().snapshot
    }
}

private struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        TimelineView(.periodic(from: entry.date, by: 60)) { timeline in
            VStack(alignment: .leading, spacing: family == .systemMedium ? 3 : 7) {
                header
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)

                UsageSummaryView(
                    snapshot: entry.snapshot,
                    now: timeline.date,
                    style: family == .systemMedium ? .compact : .widgetGrid
                )
            }
            .containerBackground(for: .widget) {
                widgetBackground
            }
        }
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(
                    LinearGradient(
                        colors: [
                            UsageTheme.accent(for: .claude),
                            UsageTheme.accent(for: .codex),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            Text("AI LIMITS")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(1.1)
                .foregroundStyle(.white.opacity(0.72))

            Spacer()

            Group {
                Text("\(UsageRoster.seats.count) seats")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.38))
            }
        }
    }

    private var widgetBackground: some View {
        ZStack {
            UsageTheme.canvas

            RadialGradient(
                colors: [
                    UsageTheme.accent(for: .codex).opacity(0.20),
                    .clear,
                ],
                center: .topTrailing,
                startRadius: 0,
                endRadius: 190
            )

            RadialGradient(
                colors: [
                    UsageTheme.accent(for: .claude).opacity(0.13),
                    .clear,
                ],
                center: .bottomLeading,
                startRadius: 0,
                endRadius: 180
            )
        }
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UsageWidget", provider: UsageTimelineProvider()) { entry in
            UsageWidgetView(entry: entry)
        }
        .configurationDisplayName("AI usage")
        .description("Fable, Gnomon, Theoros, Ariadne, and Talos subscription usage.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
