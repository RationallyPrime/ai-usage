import SwiftUI
import UsageKit

public enum UsageSummaryStyle: Sendable {
    case dashboard
    case compact
    case widgetGrid
}

/// The same five roster entries appear in the app and both widget sizes,
/// including before setup, while offline, and when a collector is silent.
public struct UsageSummaryView: View {
    private let snapshot: UsageSnapshot?
    private let now: Date
    private let style: UsageSummaryStyle

    public init(snapshot: UsageSnapshot?, now: Date, style: UsageSummaryStyle = .dashboard) {
        self.snapshot = snapshot
        self.now = now
        self.style = style
    }

    public var body: some View {
        switch style {
        case .dashboard, .compact:
            VStack(alignment: .leading, spacing: style == .dashboard ? 12 : 2) {
                ForEach(UsageRoster.seats) { seat in
                    tile(seat, style: style == .dashboard ? .dashboard : .compact)
                }
            }
        case .widgetGrid:
            GeometryReader { geometry in
                let rows = Int(ceil(Double(UsageRoster.seats.count) / 2))
                let rowHeight = max(48, (geometry.size.height - CGFloat(rows - 1) * 5) / CGFloat(rows))
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 5) {
                    ForEach(UsageRoster.seats) { seat in
                        tile(seat, style: .widgetCard).frame(height: rowHeight)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func tile(_ seat: UsageSeat, style: PoolTileStyle) -> some View {
        if let pool = seat.pool(in: snapshot) {
            PoolTile(pool: pool, now: now, style: style, seat: seat)
        } else {
            VStack(alignment: .leading, spacing: style == .compact ? 0 : 5) {
                HStack {
                    Text(seat.name).fontWeight(.semibold).foregroundStyle(.white)
                    Spacer(minLength: 2)
                    Text("No reading").foregroundStyle(.white.opacity(0.5))
                }
                if style == .dashboard {
                    Text(seat.subscription.plan)
                        .foregroundStyle(UsageTheme.accent(for: seat.subscription.provider))
                }
                Text(seat.locationSummary).foregroundStyle(.white.opacity(0.5))
            }
            .font(style == .compact ? .system(size: 8, design: .rounded) : .caption)
            .padding(.horizontal, style == .compact ? 5 : 15)
            .padding(.vertical, style == .compact ? 1 : 15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(UsageTheme.card, in: RoundedRectangle(cornerRadius: style == .compact ? 7 : 19))
            .accessibilityElement(children: .combine)
        }
    }
}

#Preview("Five seats") {
    UsageSummaryView(snapshot: .sample(now: Date()), now: Date())
        .padding()
        .background(UsageTheme.canvas)
        .preferredColorScheme(.dark)
        .frame(width: 390)
}
