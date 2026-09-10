import Foundation

extension UsageSnapshot {
    /// Synthetic quota values use the real roster so all five gallery entries
    /// exercise the same shared-subscription presentation as the live feed.
    public static func sample(now: Date) -> UsageSnapshot {
        UsageSnapshot(generatedAt: now, pools: UsageRoster.subscriptions.enumerated().map { index, subscription in
            UsagePool(
                id: "preview-\(subscription.profileID)", provider: subscription.provider,
                label: subscription.plan, identityState: .verified, status: .ok,
                sampledAt: now.addingTimeInterval(-180), receivedAt: now.addingTimeInterval(-120),
                windows: [
                    UsageWindow(id: "seven-day", label: "7d", durationMinutes: 10_080,
                                utilization: [0.42, 0.71, 0.48, 0.03][index],
                                resetsAt: now.addingTimeInterval(31 * 3600))
                ],
                profiles: [ObserverProfile(
                    id: subscription.profileID, label: subscription.members.joined(separator: " + "),
                    sourceHost: subscription.host, lastSeenAt: now.addingTimeInterval(-180),
                    state: .current, bindingConfidence: .subject
                )]
            )
        })
    }
}
