import Foundation

/// The schema-3 read projection served by the aggregator. Pool order is part
/// of the server contract: clients preserve it instead of sorting opaque IDs.
public struct UsageSnapshot: Codable, Sendable, Equatable {
    public let schema: Int
    public let generatedAt: Date
    public let pools: [UsagePool]

    public init(schema: Int = 3, generatedAt: Date, pools: [UsagePool]) {
        self.schema = schema
        self.generatedAt = generatedAt
        self.pools = pools
    }

    private enum CodingKeys: String, CodingKey {
        case schema
        case generatedAt
        case pools
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(Int.self, forKey: .schema)
        guard schema == 3 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schema,
                in: container,
                debugDescription: "Unsupported usage schema \(schema); expected schema 3."
            )
        }
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        pools = try container.decode([UsagePool].self, forKey: .pools)
    }
}

public enum UsageProviderKind: String, Codable, Sendable, Equatable {
    case claude
    case codex
    case grok
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = UsageProviderKind(rawValue: raw) ?? .unknown
    }
}

/// Whether the aggregator could reconcile provider identity evidence with the
/// observed quota windows. A conflict is evidence to show, never permission
/// for the client to rename or merge pools.
public enum PoolIdentityState: String, Codable, Sendable, Equatable {
    case verified
    case provisional
    case conflict
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PoolIdentityState(rawValue: raw) ?? .unknown
    }
}

/// The latest collector/provider condition for a pool. Non-OK states may
/// still carry last-good windows; clients keep those values visible and dim.
public enum PoolStatus: String, Codable, Sendable, Equatable {
    case ok
    case stale
    case authExpired = "auth_expired"
    case billingUnavailable = "billing_unavailable"
    case error
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PoolStatus(rawValue: raw) ?? .unknown
    }
}

/// One quota-bearing provider subject. A pool survives account switches and
/// may have zero, one, or several observer profiles currently bound to it.
public struct UsagePool: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let provider: UsageProviderKind
    public let label: String
    public let identityState: PoolIdentityState
    public let status: PoolStatus
    public let sampledAt: Date
    public let receivedAt: Date
    public let windows: [UsageWindow]
    public let profiles: [ObserverProfile]

    public init(
        id: String,
        provider: UsageProviderKind,
        label: String,
        identityState: PoolIdentityState,
        status: PoolStatus,
        sampledAt: Date,
        receivedAt: Date,
        windows: [UsageWindow],
        profiles: [ObserverProfile]
    ) {
        self.id = id
        self.provider = provider
        self.label = label
        self.identityState = identityState
        self.status = status
        self.sampledAt = sampledAt
        self.receivedAt = receivedAt
        self.windows = windows
        self.profiles = profiles
    }

}

public enum ObserverProfileState: String, Codable, Sendable, Equatable {
    case current
    case recent
    case stale
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ObserverProfileState(rawValue: raw) ?? .unknown
    }
}

public enum BindingConfidence: String, Codable, Sendable, Equatable {
    case subject
    case windowContinuity = "window_continuity"
    case profileHistory = "profile_history"
    case provisional
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BindingConfidence(rawValue: raw) ?? .unknown
    }
}

/// A named local profile observing a pool. `sourceHost` describes the edge;
/// neither profile nor edge identity is ever reused as the pool identity.
public struct ObserverProfile: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let sourceHost: String
    public let lastSeenAt: Date
    public let state: ObserverProfileState
    public let bindingConfidence: BindingConfidence

    public init(
        id: String,
        label: String,
        sourceHost: String,
        lastSeenAt: Date,
        state: ObserverProfileState,
        bindingConfidence: BindingConfidence
    ) {
        self.id = id
        self.label = label
        self.sourceHost = sourceHost
        self.lastSeenAt = lastSeenAt
        self.state = state
        self.bindingConfidence = bindingConfidence
    }
}

/// One provider-defined quota window. `utilization` is 0...1 on the wire and
/// `resetsAt` may be absent when the provider does not publish a boundary.
public struct UsageWindow: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let durationMinutes: Int?
    public let utilization: Double
    public let resetsAt: Date?

    public init(
        id: String,
        label: String,
        durationMinutes: Int? = nil,
        utilization: Double,
        resetsAt: Date?
    ) {
        self.id = id
        self.label = label
        self.durationMinutes = durationMinutes
        self.utilization = utilization
        self.resetsAt = resetsAt
    }

    public var fraction: Double { min(max(utilization, 0), 1) }
}
