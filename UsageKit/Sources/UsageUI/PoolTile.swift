import SwiftUI
import UsageKit

public enum PoolTileStyle: Sendable {
    case dashboard
    case compact
    case widgetCard
}

/// A named seat displaying its configured subscription reading.
public struct PoolTile: View {
    private let pool: UsagePool
    private let now: Date
    private let style: PoolTileStyle
    private let seat: UsageSeat

    public init(pool: UsagePool, now: Date, style: PoolTileStyle = .dashboard, seat: UsageSeat) {
        self.pool = pool
        self.now = now
        self.style = style
        self.seat = seat
    }

    private var state: PoolTileState { pool.tileState(now: now) }
    private var accent: Color { UsageTheme.accent(for: pool.provider) }

    private var dimmed: Bool {
        switch state {
        case .live(let freshness): freshness != .fresh
        case .degraded, .unavailable: true
        }
    }

    public var body: some View {
        Group {
            switch style {
            case .dashboard: dashboardTile
            case .compact: compactTile
            case .widgetCard: widgetCard
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var dashboardTile: some View {
        VStack(alignment: .leading, spacing: 13) {
            dashboardHeader

            if state.showsNumbers, !pool.windows.isEmpty {
                VStack(spacing: 12) {
                    ForEach(pool.windows) { window in
                        dashboardWindow(window)
                    }
                }
            } else {
                unavailableView
            }

            dashboardProfiles
        }
        .padding(15)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .fill(UsageTheme.card)
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [accent.opacity(0.17), .clear, .clear],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 19, style: .continuous)
                .stroke(UsageTheme.border, lineWidth: 1)
        }
    }

    private var dashboardHeader: some View {
        HStack(spacing: 10) {
            providerBadge(size: 34, iconSize: 13)

            VStack(alignment: .leading, spacing: 2) {
                Text(seat.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                Text(seat.subscription.plan)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(accent.opacity(0.92))
            }

            Spacer(minLength: 6)
            freshnessBadge
        }
    }

    private func dashboardWindow(_ window: UsageWindow) -> some View {
        VStack(spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(window.label.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(accent)

                Text(longResetText(for: window))
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.48))
                    .lineLimit(1)

                Spacer(minLength: 6)

                Text(UsageFormat.percent(window.fraction))
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }

            UsageBar(fraction: window.fraction, dimmed: dimmed, accent: accent, height: 8)
        }
    }

    private var dashboardProfiles: some View {
        Text(seat.locationSummary)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.white.opacity(0.55))
    }

    /// Compact rows fit the fixed five seats in the medium widget.
    private var compactTile: some View {
        HStack(spacing: 5) {
            providerBadge(size: 16, iconSize: 7)

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 3) {
                    Text(seat.name)
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                }

                Text(compactProfileAndAgeText)
                    .font(.system(size: 7, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.42))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if state.showsNumbers, !pool.windows.isEmpty {
                HStack(spacing: 4) {
                    ForEach(pool.windows.prefix(2)) { window in
                        compactWindow(window)
                    }
                }
            } else {
                Text(shortUnavailableReason)
                    .font(.system(size: 7, weight: .medium))
                    .foregroundStyle(.white.opacity(0.52))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .frame(minHeight: 20)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 7))
        .overlay(alignment: .leading) {
            Capsule().fill(accent).frame(width: 2).padding(.vertical, 4)
        }
    }

    private func compactWindow(_ window: UsageWindow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text(window.label)
                .foregroundStyle(.white.opacity(0.44))
            Text(UsageFormat.percent(window.fraction))
                .fontWeight(.bold)
                .foregroundStyle(meterTextColor(for: window.fraction))
        }
        .font(.system(size: 8, design: .rounded))
        .monospacedDigit()
        .opacity(dimmed ? 0.55 : 1)
    }

    private var widgetCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                providerBadge(size: 19, iconSize: 8)
                Text(seat.name)
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                Spacer(minLength: 1)
            }

            Text(compactProfileAndAgeText)
                .font(.system(size: 7, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.42))
                .lineLimit(1)
                .minimumScaleFactor(0.65)

            Spacer(minLength: 0)

            if state.showsNumbers, !pool.windows.isEmpty {
                VStack(spacing: 3) {
                    ForEach(pool.windows.prefix(2)) { window in
                        widgetWindow(window)
                    }
                }
            } else {
                Text(shortUnavailableReason)
                    .font(.system(size: 8))
                    .foregroundStyle(.white.opacity(0.48))
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(Color.white.opacity(0.065))
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [accent.opacity(0.14), .clear],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(Color.white.opacity(0.08))
        }
    }

    private func widgetWindow(_ window: UsageWindow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(window.label.uppercased())
                .font(.system(size: 7, weight: .bold, design: .rounded))
                .foregroundStyle(accent)
            Spacer(minLength: 1)
            Text(UsageFormat.percent(window.fraction))
                .font(.system(size: 8, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
            Text(shortResetText(for: window))
                .font(.system(size: 7, design: .rounded))
                .foregroundStyle(.white.opacity(0.38))
                .lineLimit(1)
        }
        .opacity(dimmed ? 0.55 : 1)
    }

    private func providerBadge(size: CGFloat, iconSize: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(UsageTheme.providerGradient(for: pool.provider))
                .shadow(color: accent.opacity(0.28), radius: 4, y: 1)
            Image(systemName: providerIcon)
                .font(.system(size: iconSize, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(seat.subscription.plan)
    }

    @ViewBuilder
    private var freshnessBadge: some View {
        switch state {
        case .live(let freshness):
            ageBadge(freshness: freshness, status: nil)
        case .degraded(let freshness, let status):
            ageBadge(freshness: freshness, status: status)
        case .unavailable(let status):
            statusBadge(
                "\(statusTitle(status)) · \(UsageFormat.age(pool.age(now: now)))",
                color: statusColor(status)
            )
        }
    }

    private func ageBadge(freshness: Freshness, status: PoolStatus?) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(status.map(statusColor) ?? (freshness == .fresh ? .green : .orange))
                .frame(width: 6, height: 6)
            Text(
                status.map { "\(statusTitle($0)) · \(UsageFormat.age(pool.age(now: now)))" }
                    ?? UsageFormat.age(pool.age(now: now))
            )
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
        }
        .foregroundStyle(.white.opacity(freshness == .fresh && status == nil ? 0.68 : 0.48))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.06), in: Capsule())
    }

    private func statusBadge(_ title: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(title).font(.caption2.weight(.semibold))
        }
        .foregroundStyle(.white.opacity(0.68))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.06), in: Capsule())
    }

    private var unavailableView: some View {
        HStack(spacing: 9) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(statusTitle(pool.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
                Text(unavailableReason)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.46))
            }
        }
    }

    private var compactProfileAndAgeText: String {
        "\(seat.locationSummary) · \(UsageFormat.age(pool.age(now: now)))"
    }

    private func meterTextColor(for fraction: Double) -> Color {
        switch fraction {
        case ..<0.70: .white
        case ..<0.90: Color(red: 1.000, green: 0.760, blue: 0.260)
        default: Color(red: 1.000, green: 0.385, blue: 0.330)
        }
    }

    private func longResetText(for window: UsageWindow) -> String {
        guard let resetsAt = window.resetsAt else { return "Reset time unavailable" }
        guard resetsAt > now else { return "Reset passed · awaiting a fresh reading" }
        return "Resets in \(UsageFormat.countdown(to: resetsAt, from: now))"
    }

    private func shortResetText(for window: UsageWindow) -> String {
        guard let resetsAt = window.resetsAt else { return "no reset" }
        guard resetsAt > now else { return "passed" }
        return UsageFormat.countdown(to: resetsAt, from: now)
    }

    private var unavailableReason: String {
        switch pool.status {
        case .authExpired: "A current observer needs provider sign-in."
        case .billingUnavailable: "Billing data is unavailable; no zero was inferred."
        case .error: "The collector reported an error."
        case .unknown: "This app does not recognize the reported status yet."
        case .ok, .stale: "This provider did not report any quota windows."
        }
    }

    private var shortUnavailableReason: String { statusTitle(pool.status).lowercased() }

    private func statusTitle(_ status: PoolStatus) -> String {
        switch status {
        case .ok: "No limits"
        case .stale: "Stale"
        case .authExpired: "Sign in"
        case .billingUnavailable: "Billing unavailable"
        case .error: "Collector error"
        case .unknown: "Unknown"
        }
    }

    private func statusColor(_ status: PoolStatus) -> Color {
        switch status {
        case .ok: .green
        case .stale, .authExpired, .billingUnavailable: .orange
        case .error: .red
        case .unknown: .gray
        }
    }

    private var providerIcon: String {
        switch pool.provider {
        case .claude: "sparkles"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .grok: "xmark"
        case .unknown: "gauge.with.dots.needle.33percent"
        }
    }
}

#Preview("Pool dashboard") {
    ScrollView {
        VStack(spacing: 12) {
            ForEach(UsageRoster.seats) { seat in
                if let pool = seat.pool(in: .sample(now: .now)) {
                    PoolTile(pool: pool, now: .now, seat: seat)
                }
            }
        }
        .padding()
    }
    .background(UsageTheme.canvas)
    .preferredColorScheme(.dark)
    .frame(width: 390, height: 700)
}
