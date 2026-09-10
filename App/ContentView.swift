import SwiftUI
import UsageKit
import UsageUI
import WidgetKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var refreshState: UsageRefreshState = .unconfigured
    @State private var endpoint = ""
    @State private var token = ""
    @State private var validationMessage: String?
    @State private var isRefreshing = false
    @State private var saved = false
    @State private var isConnectionExpanded = false

    private let store: UsageStore?
    private let storeConfigurationError: String?

    init() {
        do {
            store = try UsageStore.shared()
            storeConfigurationError = nil
        } catch {
            store = nil
            storeConfigurationError = error.localizedDescription
        }
    }

    var body: some View {
        ZStack {
            backdrop

            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        hero
                        refreshNotice

                        TimelineView(.periodic(from: .now, by: 30)) { timeline in
                            UsageSummaryView(
                                snapshot: refreshState.snapshot,
                                now: timeline.date,
                                style: .dashboard
                            )
                        }

                        connectionPanel
                    }
                    .padding(.vertical, 20)
                    .frame(
                        width: min(max(geometry.size.width - 36, 280), 560),
                        alignment: .leading
                    )
                }
                .frame(width: geometry.size.width)
            }
        }
        .preferredColorScheme(.dark)
        .task { await load() }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(60)) }
                catch { return }
            }
        }
    }

    private var backdrop: some View {
        UsageTheme.canvas
            .overlay {
                RadialGradient(
                    colors: [
                        UsageTheme.accent(for: .codex).opacity(0.24),
                        UsageTheme.accent(for: .codex).opacity(0),
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: 230
                )
                .frame(width: 460, height: 460)
                .offset(x: 210, y: -330)
            }
            .overlay {
                RadialGradient(
                    colors: [
                        UsageTheme.accent(for: .claude).opacity(0.16),
                        UsageTheme.accent(for: .claude).opacity(0),
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: 210
                )
                .frame(width: 420, height: 420)
                .offset(x: -230, y: 360)
            }
            .overlay {
                LinearGradient(
                    colors: [.clear, Color.black.opacity(0.22)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .clipped()
            .ignoresSafeArea()
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                brandMark

                VStack(alignment: .leading, spacing: 3) {
                    Text("AI USAGE")
                        .font(.caption2.weight(.bold))
                        .tracking(1.8)
                        .foregroundStyle(.white.opacity(0.46))

                    Text("Your limits")
                        .font(.system(.title, design: .rounded, weight: .bold))
                        .foregroundStyle(.white)
                }

                Spacer(minLength: 12)

                Button {
                    Task { await refresh() }
                } label: {
                    Group {
                        if isRefreshing {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.subheadline.weight(.bold))
                        }
                    }
                    .frame(width: 36, height: 36)
                    .foregroundStyle(.white.opacity(0.84))
                    .background(Color.white.opacity(0.075), in: Circle())
                    .overlay {
                        Circle().stroke(Color.white.opacity(0.09), lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isRefreshing || store?.endpoint == nil)
                .accessibilityLabel("Refresh usage")
            }

            HStack(spacing: 10) {
                statusPill

                Text(poolSummary)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white.opacity(0.48))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .padding(18)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(Color.white.opacity(0.065))

                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                UsageTheme.accent(for: .claude).opacity(0.12),
                                .clear,
                                UsageTheme.accent(for: .codex).opacity(0.13),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.white.opacity(0.11), lineWidth: 1)
        }
    }

    private var brandMark: some View {
        ZStack {
            Circle()
                .fill(Color.white.opacity(0.065))
            Circle()
                .stroke(
                    LinearGradient(
                        colors: [
                            UsageTheme.accent(for: .claude),
                            UsageTheme.accent(for: .codex),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 2
                )
                .padding(3)
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: 44, height: 44)
        .shadow(color: UsageTheme.accent(for: .codex).opacity(0.18), radius: 10, y: 4)
    }

    @ViewBuilder
    private var statusPill: some View {
        switch refreshState {
        case .live:
            pill("Live", icon: "checkmark.circle.fill", tint: .green)
        case .cached:
            pill("Cached", icon: "clock.badge.exclamationmark", tint: .orange)
        case .failed:
            pill("Offline", icon: "exclamationmark.triangle.fill", tint: .red)
        case .unconfigured:
            pill("Setup", icon: "gearshape.fill", tint: .gray)
        }
    }

    private func pill(_ title: String, icon: String, tint: Color) -> some View {
        Label(title, systemImage: icon)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(tint.opacity(0.11), in: Capsule())
            .overlay {
                Capsule().stroke(tint.opacity(0.18), lineWidth: 1)
            }
    }

    @ViewBuilder
    private var refreshNotice: some View {
        switch refreshState {
        case .cached(_, let message):
            notice(
                "Showing the last good reading",
                detail: message,
                icon: "clock.arrow.circlepath",
                tint: .orange
            )
        case .failed(let message):
            notice(
                "The usage feed is offline",
                detail: message,
                icon: "wifi.exclamationmark",
                tint: .red
            )
        case .live, .unconfigured:
            EmptyView()
        }
    }

    private func notice(_ title: String, detail: String, icon: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.46))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(tint.opacity(0.15), lineWidth: 1)
        }
    }

    private var connectionPanel: some View {
        DisclosureGroup(isExpanded: $isConnectionExpanded) {
            settings
                .padding(.top, 14)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "lock.shield.fill")
                    .font(.subheadline)
                    .foregroundStyle(UsageTheme.accent(for: .codex))
                    .frame(width: 30, height: 30)
                    .background(
                        UsageTheme.accent(for: .codex).opacity(0.10),
                        in: Circle()
                    )

                VStack(alignment: .leading, spacing: 1) {
                    Text("Private connection")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.84))
                    Text(connectionStatus)
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.42))
                }
            }
        }
        .tint(.white.opacity(0.55))
        .padding(14)
        .background(
            Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.white.opacity(0.075), lineWidth: 1)
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Feed URL")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.48))

                TextField("https://host/v3/usage", text: $endpoint)
                    .textFieldStyle(.plain)
                    .font(.caption)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 10)
                    .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.white.opacity(0.08), lineWidth: 1)
                    }
                    #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    #endif
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Read token")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.48))

                SecureField("Private read token", text: $token)
                    .textFieldStyle(.plain)
                    .font(.caption)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 10)
                    .background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.white.opacity(0.08), lineWidth: 1)
                    }
            }

            Label(
                "The token stays in shared, non-syncing Keychain storage; only the endpoint and cached reading use the App Group.",
                systemImage: "checkmark.shield"
            )
            .font(.caption2)
            .foregroundStyle(.white.opacity(0.38))

            if let validationMessage {
                Text(validationMessage)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.red)
            }

            HStack(spacing: 10) {
                Button("Save & refresh") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .tint(UsageTheme.accent(for: .codex))
                    .disabled(isRefreshing || store == nil)

                Button("Refresh now") { Task { await refresh() } }
                    .buttonStyle(.bordered)
                    .tint(.white.opacity(0.76))
                    .disabled(isRefreshing || store?.endpoint == nil)

                if saved {
                    Label("Saved", systemImage: "checkmark")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.green)
                        .transition(.opacity.combined(with: .scale))
                }
            }
        }
    }

    private var poolSummary: String {
        "\(UsageRoster.seats.count) seats · \(UsageRoster.subscriptions.count) subscriptions"
    }

    private var connectionStatus: String {
        switch refreshState {
        case .live: "Connected and receiving readings"
        case .cached: "Connected · showing cached data"
        case .failed: "Connection needs attention"
        case .unconfigured: endpoint.isEmpty ? "Not configured" : "Ready to connect"
        }
    }

    private func load() async {
        #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--sample-usage") {
                let now = Date()
                refreshState = .live(.sample(now: now))
                return
            }
        #endif

        guard let store else {
            refreshState = .failed(
                message: storeConfigurationError
                    ?? "Shared app and widget storage is unavailable."
            )
            isConnectionExpanded = true
            return
        }
        let configuredEndpoint = store.endpoint
        endpoint = configuredEndpoint?.absoluteString ?? ""
        do {
            token = try store.readToken() ?? ""
        } catch {
            refreshState = .failed(message: error.localizedDescription)
            isConnectionExpanded = true
            return
        }
        isConnectionExpanded = configuredEndpoint.map {
            !UsageEndpointPolicy().allows($0)
        } ?? true
        await refresh()
    }

    private func save() async {
        guard let store else { return }
        validationMessage = nil

        guard let url = validatedEndpoint() else { return }
        guard UsageReadTokenPolicy().allows(token) else {
            validationMessage =
                "The read token must contain 16–512 ASCII characters without spaces."
            return
        }

        do {
            try store.saveToken(token)
        } catch {
            validationMessage = error.localizedDescription
            return
        }
        store.endpoint = url
        await refresh()

        if case .live = refreshState {
            withAnimation(.easeInOut(duration: 0.2)) {
                saved = true
                isConnectionExpanded = false
            }
            try? await Task.sleep(for: .seconds(2))
            withAnimation { saved = false }
        }
    }

    private func refresh() async {
        guard let store, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        refreshState = await store.refreshConfigured()
        WidgetCenter.shared.reloadAllTimelines()
    }

    private func validatedEndpoint() -> URL? {
        guard let url = URL(string: endpoint), UsageEndpointPolicy().allows(url) else {
            validationMessage = "Enter the HTTPS /v3/usage URL (or loopback HTTP for development)."
            return nil
        }
        return url
    }
}

#Preview {
    ContentView()
}
