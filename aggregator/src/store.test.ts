import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { parseObservation, type UsageObservation, type UsageWindow } from "./contract.js";
import { VALID_OBSERVATION } from "./test-fixtures.js";
import {
  DEFAULT_STORE_OPTIONS,
  StoreCapacityError,
  openStore,
  type StoreOptions,
} from "./store.js";

const SUBJECT_A = "a".repeat(64);
const SUBJECT_B = "b".repeat(64);
const SUBJECT_C = "c".repeat(64);

function observation(
  overrides: Partial<Record<keyof UsageObservation, unknown>> = {},
): UsageObservation {
  return parseObservation({
    ...VALID_OBSERVATION,
    observation_id: randomUUID(),
    provider_subject: SUBJECT_A,
    ...overrides,
  });
}

function windows(
  utilization: number,
  resetsAt: string | null = "2026-08-15T18:00:00.000Z",
): UsageWindow[] {
  return [{
    id: "five-hour",
    label: "5h",
    duration_minutes: 300,
    utilization,
    resets_at: resetsAt,
  }];
}

// The shape a real Claude observation carries: a five-hour window plus a
// seven-day window whose boundary outlives many five-hour generations
// (`edge/ai_usage/claude_sensor.py`, and the `VALID_OBSERVATION` fixture).
// The weekly window carries its own utilization because it does not reset
// when the five-hour one does: across a five-hour reset its utilization must
// still rise, or the observation reads as a regression on an unreset window.
function claudeWindows(
  utilization: number,
  resetsAt: string | null = "2026-08-15T18:00:00.000Z",
  weekly: { utilization?: number; resets_at?: string | null } = {},
): UsageWindow[] {
  const {
    utilization: weeklyUtilization = utilization / 2,
    resets_at: weeklyResetsAt = "2026-08-20T12:00:00.000Z",
  } = weekly;
  return [
    ...windows(utilization, resetsAt),
    {
      id: "seven-day",
      label: "7d",
      duration_minutes: 10_080,
      utilization: weeklyUtilization,
      resets_at: weeklyResetsAt,
    },
  ];
}

async function freshStore(options: Partial<StoreOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "usage-v3-store-"));
  return {
    dir,
    store: await openStore(dir, { ...DEFAULT_STORE_OPTIONS, ...options }),
  };
}

describe("UsageStore schema-3 reconciliation", () => {
  test("projects three subjects as three stable pools", async () => {
    const { store } = await freshStore();
    await Promise.all([
      store.ingest(observation({ profile_id: "profile-a", provider_subject: SUBJECT_A, sequence: 1 }), "2026-08-15T15:30:01Z"),
      store.ingest(observation({ profile_id: "profile-b", provider_subject: SUBJECT_B, sequence: 1 }), "2026-08-15T15:30:02Z"),
      store.ingest(observation({ profile_id: "profile-c", provider_subject: SUBJECT_C, sequence: 1 }), "2026-08-15T15:30:03Z"),
    ]);

    const snapshot = store.snapshot("2026-08-15T15:31:00Z");
    expect(snapshot.schema).toBe(3);
    expect(snapshot.pools).toHaveLength(3);
    expect(snapshot.pools.map((pool) => pool.profiles[0]?.id)).toEqual([
      "profile-a",
      "profile-b",
      "profile-c",
    ]);
    store.close();
  });

  test("account switch preserves the old pool and lists both profiles on the shared pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      profile_label: "Laptop A",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "stable-session",
      windows: windows(0.2),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      profile_label: "Desktop B",
      provider_subject: SUBJECT_B,
      sequence: 1,
      windows: windows(0.4, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:30:02Z");
    store.ingest(observation({
      profile_id: "profile-a",
      profile_label: "Laptop A",
      provider_subject: SUBJECT_B,
      sequence: 2,
      session_id: "stable-session",
      sampled_at: "2026-08-15T15:30:30Z",
      observed_at: "2026-08-15T15:30:31Z",
      windows: windows(0.41, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:30:32Z");

    let snapshot = store.snapshot("2026-08-15T15:31:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A))?.profiles).toEqual([]);
    expect(snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B))?.profiles.map((profile) => profile.id))
      .toEqual(["profile-a", "profile-b"]);

    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      session_id: "stable-session",
      sampled_at: "2026-08-15T15:31:30Z",
      observed_at: "2026-08-15T15:31:31Z",
      windows: windows(0.21),
    }), "2026-08-15T15:31:32Z");
    snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A))?.profiles.map((profile) => profile.id))
      .toEqual(["profile-a"]);
    store.close();
  });

  test("newer delivery wins and an older retry is acknowledged without mutation", async () => {
    const { store } = await freshStore();
    const newer = observation({
      sequence: 20,
      sampled_at: "2026-08-15T15:20:00Z",
      observed_at: "2026-08-15T15:20:01Z",
      windows: windows(0.58),
    });
    const older = observation({
      sequence: 19,
      sampled_at: "2026-08-15T15:10:00Z",
      observed_at: "2026-08-15T15:10:01Z",
      windows: windows(0.54),
    });
    expect(store.ingest(newer, "2026-08-15T15:20:02Z").outcome).toBe("accepted");
    expect(store.ingest(older, "2026-08-15T15:20:03Z").outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:21:00Z").pools[0]?.windows[0]?.utilization).toBe(0.58);
    store.close();
  });

  test("a different observation cannot reuse an accepted profile sequence", async () => {
    const { store } = await freshStore();
    store.ingest(observation({ sequence: 20, windows: windows(0.5) }), "2026-08-15T15:30:01Z");
    const collision = store.ingest(observation({
      sequence: 20,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.7),
    }), "2026-08-15T15:31:02Z");
    expect(collision.outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:32:00Z").pools[0]?.windows[0]?.utilization).toBe(0.5);
    store.close();
  });

  test("a same-instance sequence regression is ignored but named per-profile", async () => {
    const { store } = await freshStore();
    store.ingest(observation({ sequence: 318, windows: windows(0.5) }), "2026-08-15T15:30:01Z");

    // Same installation generation, NEW observation id, regressed counter —
    // the signature of a sequence file lost to an unclean shutdown (written
    // sync=false by budgeted design). The observation stays ignored, but the
    // collector would otherwise be silently stranded until its counter
    // climbs back past the server's mark: the doctor must name it.
    const regressed = store.ingest(observation({
      sequence: 3,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.6),
    }), "2026-08-15T15:31:02Z");
    expect(regressed.outcome).toBe("ignored");
    const doctor = store.doctorProfiles("2026-08-15T15:32:00Z");
    expect(doctor[0]?.last_conflict?.kind).toBe("sequence_regression");
    store.close();
  });

  test("a fresh installation generation restarts its sequence legitimately", async () => {
    const { store } = await freshStore();
    // The old installation reached sequence 318.
    expect(store.ingest(observation({
      sequence: 318,
      windows: windows(0.5),
    }), "2026-08-15T15:30:01Z").outcome).toBe("accepted");

    // Reinstall without preserved state: new observer instance, sequence 0.
    // Before instance scoping this was silently ignored forever — the
    // stranded-profile failure the audit named.
    const reinstalled = store.ingest(observation({
      observer_instance_id: randomUUID(),
      sequence: 0,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.61),
    }), "2026-08-15T15:31:02Z");
    expect(reinstalled.outcome).toBe("accepted");
    expect(store.conflictCount()).toBe(1);

    // The displacement of a recently live instance is preserved as explicit
    // conflict evidence rather than silent competition — while the new
    // instance's data still lands: the pool advanced, the row was replaced.
    expect(store.snapshot("2026-08-15T15:32:00Z").pools[0]?.windows[0]?.utilization).toBe(0.61);
    const doctor = store.doctorProfiles("2026-08-15T15:32:00Z");
    expect(doctor[0]?.last_sequence).toBe(0);
    expect(doctor[0]?.last_conflict?.kind).toBe("concurrent_observer_instances");

    // The new instance's own monotonic rule still applies.
    expect(store.ingest(observation({
      observer_instance_id: doctor[0]?.observer_instance_id,
      sequence: 0,
      windows: windows(0.7),
    }), "2026-08-15T15:33:00Z").outcome).toBe("ignored");
    store.close();
  });

  test("a stale displaced instance is replaced without conflict evidence", async () => {
    const { store } = await freshStore();
    expect(store.ingest(observation({
      sequence: 42,
      windows: windows(0.5),
    }), "2026-08-15T15:30:01Z").outcome).toBe("accepted");

    // The next observation arrives a day later from a new installation. The
    // displaced instance was not recently live, so this is an ordinary
    // reinstall, not concurrent competition.
    const result = store.ingest(observation({
      observer_instance_id: randomUUID(),
      sequence: 0,
      sampled_at: "2026-08-16T15:30:00Z",
      observed_at: "2026-08-16T15:30:01Z",
      windows: windows(0.61),
    }), "2026-08-16T15:30:02Z");
    expect(result.outcome).toBe("accepted");
    expect(store.conflictCount()).toBe(0);
    store.close();
  });

  test("duplicate observation ids are idempotently acknowledged", async () => {
    const { store } = await freshStore();
    const item = observation({ sequence: 1, windows: windows(0.5) });
    expect(store.ingest(item, "2026-08-15T15:30:01Z").outcome).toBe("accepted");
    expect(store.ingest(item, "2026-08-15T15:31:01Z").outcome).toBe("duplicate");
    expect(store.snapshot("2026-08-15T15:32:00Z").pools).toHaveLength(1);
    expect(store.conflictCount()).toBe(0);
    store.close();
  });

  test("same-generation regression is retained as conflict evidence but cannot lower usage", async () => {
    const { store } = await freshStore();
    store.ingest(observation({ sequence: 1, windows: windows(0.58) }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.54),
    }), "2026-08-15T15:31:02Z");
    expect(result.outcome).toBe("conflict");
    expect(store.snapshot("2026-08-15T15:32:00Z").pools[0]?.windows[0]?.utilization).toBe(0.58);
    expect(store.conflictCount()).toBe(1);
    store.close();
  });

  test("a newly known reset cannot disguise a regression when the old boundary was unknown", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      provider: "codex",
      pool_label: "Codex · Pro",
      sequence: 1,
      windows: windows(0.58, null),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      provider: "codex",
      pool_label: "Codex · Pro",
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.1, "2026-08-15T23:00:00Z"),
    }), "2026-08-15T15:31:02Z");

    expect(result.outcome).toBe("conflict");
    const window = store.snapshot("2026-08-15T15:32:00Z").pools[0]?.windows[0];
    expect(window?.utilization).toBe(0.58);
    expect(window?.resets_at).toBeNull();
    expect(store.conflictCount()).toBe(1);
    store.close();
  });

  test("allows the explicit 0.5 percentage-point tolerance", async () => {
    const { store } = await freshStore();
    store.ingest(observation({ sequence: 1, windows: windows(0.58) }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.575),
    }), "2026-08-15T15:31:02Z");
    expect(result.outcome).toBe("accepted");
    expect(store.snapshot("2026-08-15T15:32:00Z").pools[0]?.windows[0]?.utilization).toBe(0.575);
    store.close();
  });

  test("accepts a lower value only after a legitimate reset generation", async () => {
    const { store } = await freshStore();
    // Use Codex here to isolate the provider-neutral reset-generation rule;
    // Claude additionally preserves contradictory identity evidence in a
    // provisional pool, which has its own falsifier below.
    store.ingest(observation({
      provider: "codex",
      pool_label: "Codex · Pro",
      sequence: 1,
      windows: windows(0.9),
    }), "2026-08-15T15:30:01Z");
    const premature = store.ingest(observation({
      provider: "codex",
      pool_label: "Codex · Pro",
      sequence: 2,
      sampled_at: "2026-08-15T17:00:00Z",
      observed_at: "2026-08-15T17:00:01Z",
      windows: windows(0.03, "2026-08-15T23:00:00Z"),
    }), "2026-08-15T17:00:02Z");
    expect(premature.outcome).toBe("conflict");
    expect(store.snapshot("2026-08-15T17:01:00Z").pools[0]?.windows[0]?.utilization).toBe(0.9);

    const backwardBoundary = store.ingest(observation({
      provider: "codex",
      pool_label: "Codex · Pro",
      sequence: 3,
      sampled_at: "2026-08-15T18:01:00Z",
      observed_at: "2026-08-15T18:01:01Z",
      windows: windows(0.03, "2026-08-15T17:00:00Z"),
    }), "2026-08-15T18:01:02Z");
    expect(backwardBoundary.outcome).toBe("conflict");
    expect(store.snapshot("2026-08-15T18:02:00Z").pools[0]?.windows[0]?.utilization).toBe(0.9);

    const afterBoundary = store.ingest(observation({
      provider: "codex",
      pool_label: "Codex · Pro",
      sequence: 4,
      sampled_at: "2026-08-15T18:02:00Z",
      observed_at: "2026-08-15T18:02:01Z",
      windows: windows(0.03, "2026-08-15T23:00:00Z"),
    }), "2026-08-15T18:02:02Z");
    expect(afterBoundary.outcome).toBe("accepted");
    expect(store.snapshot("2026-08-15T18:03:00Z").pools[0]?.windows[0]?.utilization).toBe(0.03);
    store.close();
  });

  test("clamps future edge clocks and marks the acknowledgement", async () => {
    const { store } = await freshStore();
    const result = store.ingest(observation({
      sequence: 1,
      observed_at: "2099-01-01T00:00:01Z",
      sampled_at: "2099-01-01T00:00:00Z",
      windows: windows(0.3, "2099-01-02T00:00:00Z"),
    }), "2026-08-15T15:30:00Z");
    expect(result.clock_skewed).toBeTrue();
    const snapshot = store.snapshot("2026-08-15T15:30:01Z");
    expect(snapshot.pools[0]?.sampled_at).toBe("2026-08-15T15:30:00.000Z");
    expect(snapshot.pools[0]?.profiles[0]?.last_seen_at).toBe("2026-08-15T15:30:00.000Z");
    store.close();
  });

  test("Claude stale auth hint follows exact window continuity without destroying either pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool A",
      windows: windows(0.6, "2026-08-15T18:00:00Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: SUBJECT_B,
      sequence: 1,
      pool_label: "Claude · Pool B",
      windows: windows(0.4, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:30:02Z");

    // The identity surface still says A, but the reset tuple and monotonic
    // value are an exact continuation of B (Anthropic #81231).
    const result = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "must-not-relabel-A",
      windows: windows(0.42, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:31:02Z");

    expect(result.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.label).toBe("Claude · Pool A");
    expect(poolA?.identity_state).toBe("conflict");
    expect(poolB?.label).toBe("Claude · Pool B");
    expect(poolB?.windows[0]?.utilization).toBe(0.42);
    expect(poolB?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("window_continuity");
    expect(store.conflictCount()).toBe(1);
    store.close();
  });

  test("Claude stale hint keeps its window-continuity binding across a quota reset", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool A",
      windows: windows(0.6, "2026-08-15T18:00:00Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: SUBJECT_B,
      sequence: 1,
      pool_label: "Claude · Pool B",
      windows: windows(0.9, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:30:02Z");

    // Exact continuity first proves that this session's stale A hint is
    // actually observing B.
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "must-not-relabel-A",
      windows: windows(0.92, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:31:02Z");

    // The next B generation has a new reset tuple, so it cannot be
    // rediscovered by exact-tuple matching. The existing continuity binding
    // must carry it across the reset instead of overwriting A.
    const result = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T19:01:00Z",
      observed_at: "2026-08-15T19:01:01Z",
      pool_label: "still-must-not-relabel-A",
      windows: windows(0.03, "2026-08-16T00:00:00Z"),
    }), "2026-08-15T19:01:02Z");

    expect(result.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T19:02:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.label).toBe("Claude · Pool A");
    expect(poolA?.windows[0]?.utilization).toBe(0.6);
    expect(poolA?.windows[0]?.resets_at).toBe("2026-08-15T18:00:00.000Z");
    expect(poolB?.label).toBe("Claude · Pool B");
    expect(poolB?.windows[0]?.utilization).toBe(0.03);
    expect(poolB?.windows[0]?.resets_at).toBe("2026-08-16T00:00:00.000Z");
    expect(poolB?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("window_continuity");
    expect(store.conflictCount()).toBe(2);
    store.close();
  });

  test("one-second reset-boundary jitter is the same generation, not a new pool", async () => {
    const { store } = await freshStore();
    // Observed live 2026-08-18: Anthropic reports the same boundaries as
    // 20:50:00/07:00:00 in one poll and 20:49:59/06:59:59 in the next.
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      windows: claudeWindows(0.11, "2026-08-15T18:00:00.000Z", {
        resets_at: "2026-08-20T12:00:00.000Z",
      }),
    }), "2026-08-15T15:30:01Z");
    const jittered = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      session_id: "session-1",
      sampled_at: "2026-08-15T15:35:00Z",
      observed_at: "2026-08-15T15:35:01Z",
      windows: claudeWindows(0.12, "2026-08-15T17:59:59.000Z", {
        resets_at: "2026-08-20T11:59:59.000Z",
      }),
    }), "2026-08-15T15:35:02Z");

    expect(jittered.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T15:36:00Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.windows.find((w) => w.id === "five-hour")?.utilization).toBe(0.12);
    expect(store.conflictCount()).toBe(0);
    store.close();
  });

  test("a real five-hour reset still transitions within the same pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      windows: claudeWindows(0.8, "2026-08-15T18:00:00.000Z"),
    }), "2026-08-15T15:30:01Z");
    // Five hours later: a genuinely new generation, far beyond any jitter
    // tolerance — must be accepted as a reset on the same pool, not merged
    // as "the same boundary" and not minted as a twin.
    const reset = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      session_id: "session-1",
      sampled_at: "2026-08-15T18:05:00Z",
      observed_at: "2026-08-15T18:05:01Z",
      // The five-hour window resets to ~0; the weekly window keeps climbing —
      // a weekly decrease without a weekly reset would be a real regression.
      windows: claudeWindows(0.02, "2026-08-15T23:00:00.000Z", {
        utilization: 0.41,
      }),
    }), "2026-08-15T18:05:02Z");

    expect(reset.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T18:06:00Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.windows.find((w) => w.id === "five-hour")?.utilization).toBe(0.02);
    expect(snapshot.pools[0]?.windows.find((w) => w.id === "five-hour")?.resets_at)
      .toBe("2026-08-15T23:00:00.000Z");
    store.close();
  });

  test("a starved subject pool reclaims its session from a subjectless twin after its generation lapses", async () => {
    const { store } = await freshStore();
    // Generation 1: the subject pool is current.
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      pool_label: "Claude · Max",
      windows: windows(0.3, "2026-08-15T18:00:00.000Z"),
    }), "2026-08-15T15:30:01Z");
    // Identity goes briefly unobservable: a new session mints a subjectless
    // twin on the next generation's windows.
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      session_id: "session-2",
      sampled_at: "2026-08-15T15:40:00Z",
      observed_at: "2026-08-15T15:40:01Z",
      windows: windows(0.1, "2026-08-15T19:00:00.000Z"),
    }), "2026-08-15T15:40:02Z");
    // While the subject pool's generation is still current, exact contrary
    // continuity legitimately outranks the hint: the session binds to the
    // twin and the subject pool starves from here on.
    const stolen = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      session_id: "session-1",
      sampled_at: "2026-08-15T16:00:00Z",
      observed_at: "2026-08-15T16:00:01Z",
      windows: windows(0.2, "2026-08-15T19:00:00.000Z"),
    }), "2026-08-15T16:00:02Z");
    expect(stolen.outcome).toBe("conflict");
    const conflictsAfterTheft = store.conflictCount();

    // The subject pool's stored generation has now lapsed entirely. The
    // tuple mismatch is starvation, not contrary identity: the twin retires
    // into the subject pool and the observation refreshes its windows.
    const reclaimed = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 4,
      session_id: "session-1",
      sampled_at: "2026-08-15T21:00:00Z",
      observed_at: "2026-08-15T21:00:01Z",
      windows: windows(0.5, "2026-08-15T19:00:00.000Z"),
    }), "2026-08-15T21:00:02Z");

    expect(reclaimed.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T21:01:00Z");
    expect(snapshot.pools).toHaveLength(1);
    const poolA = snapshot.pools[0];
    expect(poolA?.id.endsWith(SUBJECT_A)).toBe(true);
    expect(poolA?.identity_state).toBe("verified");
    expect(poolA?.windows[0]?.utilization).toBe(0.5);
    expect(poolA?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("subject");
    expect(store.conflictCount()).toBe(conflictsAfterTheft);
    store.close();
  });

  test("a starved subject pool reclaims its session while its weekly window is still current", async () => {
    // The production shape: every Claude observation carries a seven-day
    // window alongside the five-hour one. A five-hour starvation cycle
    // completes long before the weekly boundary, so the reclaim must turn on
    // the boundary the observation actually disagrees with.
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      pool_label: "Claude · Max",
      windows: claudeWindows(0.3, "2026-08-15T18:00:00.000Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      session_id: "session-2",
      sampled_at: "2026-08-15T15:40:00Z",
      observed_at: "2026-08-15T15:40:01Z",
      windows: claudeWindows(0.1, "2026-08-15T19:00:00.000Z"),
    }), "2026-08-15T15:40:02Z");
    const stolen = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      session_id: "session-1",
      sampled_at: "2026-08-15T16:00:00Z",
      observed_at: "2026-08-15T16:00:01Z",
      windows: claudeWindows(0.2, "2026-08-15T19:00:00.000Z"),
    }), "2026-08-15T16:00:02Z");
    expect(stolen.outcome).toBe("conflict");
    const conflictsAfterTheft = store.conflictCount();

    // 21:00: the five-hour boundary the observation disagrees with (18:00)
    // has passed; the seven-day boundary is unchanged and still days away.
    const reclaimed = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 4,
      session_id: "session-1",
      sampled_at: "2026-08-15T21:00:00Z",
      observed_at: "2026-08-15T21:00:01Z",
      windows: claudeWindows(0.5, "2026-08-15T19:00:00.000Z"),
    }), "2026-08-15T21:00:02Z");

    expect(reclaimed.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T21:01:00Z");
    expect(snapshot.pools).toHaveLength(1);
    const poolA = snapshot.pools[0];
    expect(poolA?.id.endsWith(SUBJECT_A)).toBe(true);
    expect(poolA?.identity_state).toBe("verified");
    expect(poolA?.windows[0]?.utilization).toBe(0.5);
    expect(poolA?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("subject");
    expect(store.conflictCount()).toBe(conflictsAfterTheft);
    store.close();
  });

  test("a still-current disagreeing window keeps the hint from claiming starvation", async () => {
    // The other direction: when the weekly boundary itself disagrees and has
    // not passed, the stored generation has not lapsed and the twin keeps the
    // session. Only an unchanged boundary is corroboration.
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      pool_label: "Claude · Max",
      windows: claudeWindows(0.3, "2026-08-15T18:00:00.000Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      session_id: "session-2",
      sampled_at: "2026-08-15T15:40:00Z",
      observed_at: "2026-08-15T15:40:01Z",
      windows: claudeWindows(0.1, "2026-08-15T19:00:00.000Z", {
        resets_at: "2026-08-22T12:00:00.000Z",
      }),
    }), "2026-08-15T15:40:02Z");
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      session_id: "session-1",
      sampled_at: "2026-08-15T16:00:00Z",
      observed_at: "2026-08-15T16:00:01Z",
      windows: claudeWindows(0.2, "2026-08-15T19:00:00.000Z", {
        resets_at: "2026-08-22T12:00:00.000Z",
      }),
    }), "2026-08-15T16:00:02Z");

    const held = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 4,
      session_id: "session-1",
      sampled_at: "2026-08-15T21:00:00Z",
      observed_at: "2026-08-15T21:00:01Z",
      windows: claudeWindows(0.5, "2026-08-15T19:00:00.000Z", {
        resets_at: "2026-08-22T12:00:00.000Z",
      }),
    }), "2026-08-15T21:00:02Z");

    expect(held.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T21:01:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(poolA?.identity_state).toBe("conflict");
    expect(poolA?.windows[0]?.utilization).toBe(0.3);
    // The twin, not the hint, still holds the session by exact continuity:
    // a lapse claim that ignored the still-current weekly disagreement would
    // strand the session on a third provisional pool instead.
    expect(poolA?.profiles).toHaveLength(0);
    const twin = snapshot.pools.find((pool) => !pool.id.endsWith(SUBJECT_A));
    expect(twin?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("window_continuity");
    store.close();
  });

  test("a lapsed hint mismatch does not reroute a fresh session onto a subjectless twin", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      windows: windows(0.3, "2026-08-15T18:00:00.000Z"),
    }), "2026-08-15T15:30:01Z");
    // A subjectless twin exists on the current generation.
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      session_id: "session-2",
      sampled_at: "2026-08-15T21:00:00Z",
      observed_at: "2026-08-15T21:00:01Z",
      windows: windows(0.1, "2026-08-16T02:00:00.000Z"),
    }), "2026-08-15T21:00:02Z");
    // A fresh session with live subject evidence and the subject pool's
    // generation lapsed: identity must win; the twin gains nothing.
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      session_id: "session-3",
      sampled_at: "2026-08-15T21:10:00Z",
      observed_at: "2026-08-15T21:10:01Z",
      windows: windows(0.15, "2026-08-16T02:00:00.000Z"),
    }), "2026-08-15T21:10:02Z");

    const snapshot = store.snapshot("2026-08-15T21:11:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(poolA?.windows[0]?.utilization).toBe(0.15);
    expect(poolA?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("subject");
    store.close();
  });

  test("a lapsed hint keeps a fresh session off a subjectless twin under a live weekly window", async () => {
    // The same refusal as above at the second guard site, in the collector's
    // real two-window shape: the weekly boundary the observation still agrees
    // with must not veto the five-hour lapse.
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      windows: claudeWindows(0.3, "2026-08-15T18:00:00.000Z", { utilization: 0.2 }),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      session_id: "session-2",
      sampled_at: "2026-08-15T21:00:00Z",
      observed_at: "2026-08-15T21:00:01Z",
      windows: claudeWindows(0.1, "2026-08-16T02:00:00.000Z", { utilization: 0.05 }),
    }), "2026-08-15T21:00:02Z");
    // The five-hour window reset; the weekly one did not, so its utilization
    // keeps climbing past the hinted pool's stored value.
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      session_id: "session-3",
      sampled_at: "2026-08-15T21:10:00Z",
      observed_at: "2026-08-15T21:10:01Z",
      windows: claudeWindows(0.15, "2026-08-16T02:00:00.000Z", { utilization: 0.22 }),
    }), "2026-08-15T21:10:02Z");

    const snapshot = store.snapshot("2026-08-15T21:11:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(poolA?.windows[0]?.utilization).toBe(0.15);
    expect(poolA?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("subject");
    store.close();
  });

  test("a lapsed hint still yields to contrary continuity carrying its own subject", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      session_id: "session-1",
      pool_label: "Claude · Pool A",
      windows: windows(0.3, "2026-08-15T18:00:00.000Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: SUBJECT_B,
      sequence: 1,
      session_id: "session-b",
      pool_label: "Claude · Pool B",
      sampled_at: "2026-08-15T20:55:00Z",
      observed_at: "2026-08-15T20:55:01Z",
      windows: windows(0.4, "2026-08-16T02:00:00.000Z"),
    }), "2026-08-15T20:55:02Z");
    // Pool A's generation has lapsed, but the exact continuation belongs to
    // a pool with its own subject — real contrary identity (#81231) still
    // outranks the stale hint.
    const result = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      session_id: "session-3",
      sampled_at: "2026-08-15T21:00:00Z",
      observed_at: "2026-08-15T21:00:01Z",
      windows: windows(0.42, "2026-08-16T02:00:00.000Z"),
    }), "2026-08-15T21:00:02Z");

    expect(result.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T21:01:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.windows[0]?.utilization).toBe(0.3);
    expect(poolB?.windows[0]?.utilization).toBe(0.42);
    expect(poolA?.identity_state).toBe("conflict");
    store.close();
  });

  test("Claude window continuity binding yields when subject and windows realign", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool A",
      windows: windows(0.6, "2026-08-15T18:00:00Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: SUBJECT_B,
      sequence: 1,
      pool_label: "Claude · Pool B",
      windows: windows(0.4, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:30:02Z");

    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.42, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:31:02Z");

    const realigned = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool A",
      windows: windows(0.62, "2026-08-15T18:00:00Z"),
    }), "2026-08-15T15:32:02Z");

    expect(realigned.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T15:33:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.windows[0]?.utilization).toBe(0.62);
    expect(poolA?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("subject");
    expect(poolB?.windows[0]?.utilization).toBe(0.42);
    store.close();
  });

  test("Claude keeps its established binding when both pools match the windows", async () => {
    const { store } = await freshStore();
    const convergedReset = "2026-08-15T20:00:00Z";
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      windows: windows(0.6, convergedReset),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-b",
      provider_subject: SUBJECT_B,
      sequence: 1,
      windows: windows(0.4, convergedReset),
    }), "2026-08-15T15:30:02Z");
    store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.42, convergedReset),
    }), "2026-08-15T15:31:02Z");

    // The next stale-A sample is monotonic for both same-generation pools, so
    // it cannot prove that the bound session has left B.
    const ambiguous = store.ingest(observation({
      profile_id: "profile-a",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      windows: windows(0.62, convergedReset),
    }), "2026-08-15T15:32:02Z");

    expect(ambiguous.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T15:33:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.windows[0]?.utilization).toBe(0.6);
    expect(poolB?.windows[0]?.utilization).toBe(0.62);
    expect(poolB?.profiles.find((profile) => profile.id === "profile-a")?.binding_confidence)
      .toBe("window_continuity");
    store.close();
  });

  test("first subject evidence promotes the same session's exact-continuity provisional pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "subject-late",
      session_id: "stable-session",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      pool_label: "Claude · Pending identity",
      windows: windows(0.4),
    }), "2026-08-15T15:30:01Z");
    const provisional = store.snapshot("2026-08-15T15:30:02Z").pools[0];
    expect(provisional?.identity_state).toBe("provisional");

    const identified = store.ingest(observation({
      profile_id: "subject-late",
      session_id: "stable-session",
      provider_subject: SUBJECT_A,
      identity_evidence: "org_email",
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "Claude · Verified",
      windows: windows(0.42),
    }), "2026-08-15T15:31:02Z");

    expect(identified.outcome).toBe("accepted");
    let snapshot = store.snapshot("2026-08-15T15:31:03Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.id).toBe(provisional?.id);
    expect(snapshot.pools[0]?.identity_state).toBe("verified");
    expect(snapshot.pools[0]?.windows[0]?.utilization).toBe(0.42);
    expect(snapshot.pools[0]?.profiles[0]?.binding_confidence).toBe("subject");

    store.ingest(observation({
      profile_id: "subject-late",
      session_id: "stable-session",
      provider_subject: SUBJECT_A,
      identity_evidence: "org_email",
      sequence: 3,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      windows: windows(0.43),
    }), "2026-08-15T15:32:02Z");
    snapshot = store.snapshot("2026-08-15T15:32:03Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.id).toBe(provisional?.id);
    store.close();
  });

  test("known subject retires a late profile's exact bound provisional pool", async () => {
    const { dir, store } = await freshStore();
    store.ingest(observation({
      profile_id: "known-b",
      profile_label: "Known B",
      session_id: "known-session",
      provider_subject: SUBJECT_B,
      sequence: 1,
      pool_label: "Claude · Pool B",
      windows: windows(0.4),
    }), "2026-08-15T15:30:01Z");
    const subjectPoolId = store.snapshot("2026-08-15T15:30:02Z").pools[0]?.id;
    if (!subjectPoolId) throw new Error("known subject pool was not projected");

    store.ingest(observation({
      profile_id: "late-profile",
      profile_label: "Late profile",
      session_id: "late-session",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "Claude · Pending identity",
      windows: windows(0.41),
    }), "2026-08-15T15:31:02Z");
    expect(store.snapshot("2026-08-15T15:31:03Z").pools).toHaveLength(2);

    const identified = observation({
      profile_id: "late-profile",
      profile_label: "Late profile",
      session_id: "late-session",
      provider_subject: SUBJECT_B,
      identity_evidence: "org_email",
      sequence: 2,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool B",
      windows: windows(0.42),
    });
    expect(store.ingest(identified, "2026-08-15T15:32:02Z").outcome).toBe("accepted");

    const snapshot = store.snapshot("2026-08-15T15:32:03Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.id).toBe(subjectPoolId);
    expect(snapshot.pools[0]?.windows[0]?.utilization).toBe(0.42);
    expect(snapshot.pools[0]?.profiles.map((profile) => profile.id).sort())
      .toEqual(["known-b", "late-profile"]);
    expect(store.latestSessionObservationId("late-profile", "late-session"))
      .toBe(identified.observation_id);
    expect(store.conflictCount()).toBe(0);
    store.close();

    const db = new Database(join(dir, "usage-v3.sqlite"));
    const latePoolIds = db.query<{ pool_id: string }, []>(`
      SELECT DISTINCT pool_id FROM observations
      WHERE profile_id = 'late-profile'
    `).all().map((row) => row.pool_id);
    expect(latePoolIds).toEqual([subjectPoolId]);
    const dangling = db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count
      FROM latest_session_observations AS latest
      LEFT JOIN pools ON pools.id = latest.pool_id
      WHERE pools.id IS NULL
    `).get()?.count;
    expect(dangling).toBe(0);
    db.close();
  });

  test("unmatched contradictory Claude windows create a provisional pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      provider_subject: SUBJECT_A,
      sequence: 1,
      windows: windows(0.6, "2026-08-15T18:00:00Z"),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.2, "2026-08-15T21:00:00Z"),
    }), "2026-08-15T15:31:02Z");
    expect(result.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.some((pool) => pool.identity_state === "provisional")).toBeTrue();
    store.close();
  });

  test("profile freshness is current through 15m, recent through 24h, then stale", async () => {
    const { store } = await freshStore();
    store.ingest(observation({ observed_at: "2026-08-15T00:00:00Z", sampled_at: "2026-08-15T00:00:00Z" }), "2026-08-15T00:00:01Z");
    expect(store.snapshot("2026-08-15T00:15:00Z").pools[0]?.profiles[0]?.state).toBe("current");
    expect(store.snapshot("2026-08-15T00:15:00.001Z").pools[0]?.profiles[0]?.state).toBe("recent");
    expect(store.snapshot("2026-08-16T00:00:00Z").pools[0]?.profiles[0]?.state).toBe("recent");
    expect(store.snapshot("2026-08-16T00:00:00.001Z").pools[0]?.profiles[0]?.state).toBe("stale");
    store.close();
  });

  test("heartbeat advances profile presence without making the provider sample fresher", async () => {
    const { store } = await freshStore();
    const sample = observation({
      sequence: 1,
      observed_at: "2026-08-15T15:00:00Z",
      sampled_at: "2026-08-15T14:59:58Z",
      windows: windows(0.5),
    });
    store.ingest(sample, "2026-08-15T15:00:01Z");
    const heartbeat = observation({
      sequence: 2,
      observed_at: "2026-08-15T15:10:00Z",
      sampled_at: "2026-08-15T14:59:58Z",
      windows: windows(0.5),
    });
    expect(store.ingest(heartbeat, "2026-08-15T15:10:01Z").outcome).toBe("accepted");
    const pool = store.snapshot("2026-08-15T15:20:00Z").pools[0];
    expect(pool?.sampled_at).toBe("2026-08-15T14:59:58.000Z");
    expect(pool?.profiles[0]?.last_seen_at).toBe("2026-08-15T15:10:00.000Z");
    expect(pool?.profiles[0]?.state).toBe("current");
    expect(store.latestSessionObservationId("desktop-a", "session-1"))
      .toBe(heartbeat.observation_id);
    store.close();
  });

  test("degraded polls do not extend authenticated profile presence", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      sequence: 1,
      observed_at: "2026-08-15T15:00:00Z",
      sampled_at: "2026-08-15T14:59:58Z",
      windows: windows(0.5),
    }), "2026-08-15T15:00:01Z");
    store.ingest(observation({
      sequence: 2,
      observed_at: "2026-08-15T15:10:00Z",
      sampled_at: "2026-08-15T14:59:58Z",
      status: "auth_expired",
      windows: windows(0.5),
    }), "2026-08-15T15:10:01Z");

    const pool = store.snapshot("2026-08-15T15:16:00Z").pools[0];
    expect(pool?.status).toBe("auth_expired");
    expect(pool?.profiles[0]?.last_seen_at).toBe("2026-08-15T15:00:00.000Z");
    expect(pool?.profiles[0]?.state).toBe("recent");
    store.close();
  });

  test("an unbound empty degraded heartbeat cannot invent a profile-derived pool", async () => {
    const { store } = await freshStore();
    const result = store.ingest(observation({
      provider_subject: null,
      identity_evidence: "unknown",
      status: "auth_expired",
      windows: [],
    }), "2026-08-15T15:30:01Z");
    expect(result.outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:31:00Z").pools).toEqual([]);
    store.close();
  });

  test("simultaneously live sessions on different pools remain visible as ambiguity", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "switching-profile",
      session_id: "session-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      windows: windows(0.4, "2026-08-15T18:00:00Z"),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      profile_id: "switching-profile",
      session_id: "session-b",
      provider_subject: SUBJECT_B,
      sequence: 2,
      observed_at: "2026-08-15T15:31:00Z",
      sampled_at: "2026-08-15T15:30:59Z",
      windows: windows(0.2, "2026-08-15T19:00:00Z"),
    }), "2026-08-15T15:31:01Z");
    expect(result.outcome).toBe("conflict");
    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.every((pool) =>
      pool.identity_state === "conflict" &&
      pool.profiles.some((profile) => profile.id === "switching-profile")
    )).toBeTrue();
    expect(store.conflictCount()).toBe(1);
    store.close();
  });

  test("lower-quality equal-time sample cannot replace higher-quality truth", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      sequence: 1,
      sample_time_quality: "transcript_mtime",
      windows: windows(0.5),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      sequence: 2,
      sample_time_quality: "sensor_time",
      windows: windows(0.6),
    }), "2026-08-15T15:30:02Z");
    expect(result.outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:31:00Z").pools[0]?.windows[0]?.utilization).toBe(0.5);
    store.close();
  });

  test("higher-quality equal-time sample upgrades projection metadata", async () => {
    const { dir, store } = await freshStore();
    store.ingest(observation({
      sequence: 1,
      pool_label: "Claude · Approximate",
      sample_time_quality: "sensor_time",
      windows: windows(0.5),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      sequence: 2,
      pool_label: "Claude · Provider confirmed",
      sample_time_quality: "provider_time",
      windows: windows(0.5),
    }), "2026-08-15T15:30:02Z");

    expect(result.outcome).toBe("accepted");
    const pool = store.snapshot("2026-08-15T15:31:00Z").pools[0];
    expect(pool?.label).toBe("Claude · Provider confirmed");
    expect(pool?.windows[0]?.utilization).toBe(0.5);
    expect(pool?.received_at).toBe("2026-08-15T15:30:02.000Z");
    const intermediate = store.ingest(observation({
      sequence: 3,
      pool_label: "must-not-replace-provider-truth",
      sample_time_quality: "transcript_mtime",
      windows: windows(0.6),
    }), "2026-08-15T15:30:03Z");
    expect(intermediate.outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:31:00Z").pools[0]?.windows[0]?.utilization)
      .toBe(0.5);
    store.close();

    const db = new Database(join(dir, "usage-v3.sqlite"));
    expect(db.query<{ sample_quality: string }, []>(
      "SELECT sample_quality FROM pools",
    ).get()?.sample_quality).toBe("provider_time");
    db.close();
  });

  test("a fresh Grok credit correction replaces 100 percent without moving the reset", async () => {
    const { store } = await freshStore();
    store.ingest(observation({provider: "grok", sequence: 1, windows: windows(1)}), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      provider: "grok", sequence: 2, windows: windows(0.03),
      observed_at: "2026-08-15T15:31:00Z", sampled_at: "2026-08-15T15:31:00Z",
    }), "2026-08-15T15:31:01Z");
    expect(result.outcome).toBe("accepted");
    expect(store.snapshot("2026-08-15T15:32:00Z").pools[0]?.windows[0]?.utilization).toBe(0.03);
    const replay = store.ingest(observation({provider: "grok", sequence: 3, windows: windows(1)}), "2026-08-15T15:32:01Z");
    expect(replay.outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:33:00Z").pools[0]?.windows[0]?.utilization).toBe(0.03);
    store.close();
  });

  test("the live projection excludes retired profiles and a profile's old session bindings", async () => {
    const { store } = await freshStore();
    store.ingest(observation({profile_id: "active", session_id: "old", sequence: 1}), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "active", session_id: "new", sequence: 2, provider_subject: SUBJECT_B,
      observed_at: "2026-08-15T15:31:00Z", sampled_at: "2026-08-15T15:31:00Z",
      windows: windows(0.9, "2026-08-15T20:00:00Z"),
    }), "2026-08-15T15:31:01Z");
    store.ingest(observation({profile_id: "retired", provider_subject: SUBJECT_C}), "2026-08-15T15:30:01Z");
    const all = store.snapshot("2026-08-15T15:32:00Z");
    expect(all.pools.length).toBeGreaterThan(1);
    const live = store.snapshot("2026-08-15T15:32:00Z", new Set(["active"]));
    expect(live.pools).toHaveLength(1);
    expect(live.pools[0]?.profiles.map(p => p.id)).toEqual(["active"]);
    expect(live.pools[0]?.windows[0]?.utilization).toBe(0.9);
    expect(store.snapshot("2026-08-15T15:32:00Z", new Set()).pools).toHaveLength(0);
    store.close();
  });

  test("billing unavailable updates status while preserving Grok's last good windows", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      provider: "grok",
      pool_label: "Grok · SuperGrok",
      sequence: 1,
      windows: windows(0.44, "2026-09-01T00:00:00Z"),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      provider: "grok",
      pool_label: "Grok · SuperGrok",
      sequence: 2,
      status: "billing_unavailable",
      observed_at: "2026-08-15T15:31:00Z",
      sampled_at: "2026-08-15T15:29:58.123Z",
      windows: [],
    }), "2026-08-15T15:31:01Z");
    const pool = store.snapshot("2026-08-15T15:32:00Z").pools[0];
    expect(pool?.status).toBe("billing_unavailable");
    expect(pool?.windows[0]?.utilization).toBe(0.44);
    store.close();
  });

  test("uses WAL and persists projections across restart with mode 0600", async () => {
    const { dir, store } = await freshStore();
    store.ingest(observation(), "2026-08-15T15:30:01Z");
    const dbPath = join(dir, "usage-v3.sqlite");
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      expect((await stat(`${dbPath}${suffix}`)).mode & 0o777).toBe(0o600);
    }
    store.close();

    const db = new Database(dbPath);
    const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    expect(journal?.journal_mode).toBe("wal");
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    expect(integrity?.integrity_check).toBe("ok");
    db.close();

    const reopened = await openStore(dir);
    expect(reopened.snapshot("2026-08-15T15:31:00Z").pools).toHaveLength(1);
    reopened.probeReady("2026-08-15T15:31:00Z");
    reopened.close();
  });

  test("narrows an existing data directory to mode 0700", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-open-dir-"));
    // mkdtemp is normally already private; explicitly broaden it to prove
    // openStore narrows an existing path rather than relying on mkdir's mode.
    await chmod(dir, 0o755);
    const store = await openStore(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    store.close();
  });

  test("one-time imports usage.json into provisional pools and removes the importer input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-migrate-"));
    const legacyPath = join(dir, "usage.json");
    await writeFile(legacyPath, JSON.stringify([
      {
        account: {
          id: "legacy-team-a",
          label: "Claude · Team",
          provider: "claude",
          source_host: "cx53",
          as_of: "2026-08-15T15:00:00Z",
          status: "ok",
          windows: windows(0.4),
        },
        received_at: "2026-08-15T15:00:01Z",
      },
      {
        account: {
          id: "legacy-team-b",
          label: "Claude · Team 2",
          provider: "claude",
          source_host: "macbook",
          as_of: "2026-08-15T15:00:00Z",
          status: "ok",
          // Coincident windows are not enough evidence to collapse two old
          // account records during a deliberately provisional migration.
          windows: windows(0.4),
        },
        received_at: "2026-08-15T15:00:01Z",
      },
    ]), "utf8");

    const store = await openStore(dir);
    const snapshot = store.snapshot("2026-08-15T15:01:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.every((pool) => pool.identity_state === "provisional")).toBeTrue();
    expect(snapshot.pools.flatMap((pool) => pool.profiles.map((profile) => profile.id)).sort())
      .toEqual(["legacy-team-a", "legacy-team-b"]);
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    store.close();
  });

  test("legacy import preserves profile IDs that begin with schema-2 punctuation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-legacy-punctuation-"));
    const legacyAccount = (id: string, utilization: number) => ({
      account: {
        id,
        label: `Claude · ${id}`,
        provider: "claude",
        source_host: "old-edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(utilization),
      },
    });
    await writeFile(
      join(dir, "usage.json"),
      JSON.stringify([
        legacyAccount(".dot-profile", 0.2),
        legacyAccount("_underscore-profile", 0.3),
        legacyAccount("-dash-profile", 0.4),
      ]),
      "utf8",
    );

    const store = await openStore(dir);
    expect(store.snapshot("2026-08-15T15:01:00Z").pools
      .flatMap((pool) => pool.profiles.map((profile) => profile.id))
      .sort())
      .toEqual(["-dash-profile", ".dot-profile", "_underscore-profile"]);
    store.close();
  });

  test("legacy import does not consume the live collector sequence namespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-legacy-sequence-"));
    await writeFile(join(dir, "usage.json"), JSON.stringify([
      {
        account: {
          id: "desktop-a",
          label: "Claude · Desktop",
          provider: "claude",
          source_host: "old-edge",
          as_of: "2026-08-15T15:00:00Z",
          status: "ok",
          windows: windows(0.4),
        },
        received_at: "2026-08-15T15:00:01Z",
      },
      {
        account: {
          id: "desktop-b",
          label: "Claude · Other",
          provider: "claude",
          source_host: "old-edge",
          as_of: "2026-08-15T15:00:00Z",
          status: "ok",
          windows: windows(0.5),
        },
        received_at: "2026-08-15T15:00:01Z",
      },
    ]), "utf8");

    const store = await openStore(dir);
    const first = store.ingest(observation({
      profile_id: "desktop-a",
      sequence: 0,
      sampled_at: "2026-08-15T15:01:00Z",
      observed_at: "2026-08-15T15:01:01Z",
      windows: windows(0.41),
    }), "2026-08-15T15:01:02Z");
    const second = store.ingest(observation({
      profile_id: "desktop-b",
      sequence: 0,
      sampled_at: "2026-08-15T15:01:00Z",
      observed_at: "2026-08-15T15:01:01Z",
      windows: windows(0.51),
    }), "2026-08-15T15:01:02Z");

    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("accepted");
    const db = new Database(join(dir, "usage-v3.sqlite"));
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM profile_sequences WHERE edge_id = 'legacy-import'",
    ).get()?.count).toBe(0);
    db.close();
    store.close();
  });

  test("first live subject promotes a unique exact-continuity schema-2 import", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-promote-import-"));
    await writeFile(join(dir, "usage.json"), JSON.stringify([{
      account: {
        id: "legacy-team",
        label: "Claude · Legacy team",
        provider: "claude",
        source_host: "old-edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(0.4),
      },
      received_at: "2026-08-15T15:00:01Z",
    }]), "utf8");

    const store = await openStore(dir);
    const legacyPool = store.snapshot("2026-08-15T15:00:02Z").pools[0];
    expect(legacyPool?.identity_state).toBe("provisional");

    const result = store.ingest(observation({
      profile_id: "live-profile",
      session_id: "live-session",
      provider_subject: SUBJECT_A,
      identity_evidence: "org_email",
      sequence: 1,
      sampled_at: "2026-08-15T15:01:00Z",
      observed_at: "2026-08-15T15:01:01Z",
      pool_label: "Claude · Live team",
      windows: windows(0.42),
    }), "2026-08-15T15:01:02Z");

    expect(result.outcome).toBe("accepted");
    let snapshot = store.snapshot("2026-08-15T15:01:03Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.id).toBe(legacyPool?.id);
    expect(snapshot.pools[0]?.identity_state).toBe("verified");
    expect(snapshot.pools[0]?.profiles.map((profile) => profile.id).sort())
      .toEqual(["legacy-team", "live-profile"]);

    store.ingest(observation({
      profile_id: "live-profile",
      session_id: "live-session",
      provider_subject: SUBJECT_A,
      identity_evidence: "org_email",
      sequence: 2,
      sampled_at: "2026-08-15T15:02:00Z",
      observed_at: "2026-08-15T15:02:01Z",
      windows: windows(0.43),
    }), "2026-08-15T15:02:02Z");
    snapshot = store.snapshot("2026-08-15T15:02:03Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.id).toBe(legacyPool?.id);
    store.close();
  });

  test("existing subject retires one unique exact-continuity schema-2 import", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-retire-import-"));
    const initial = await openStore(dir);
    initial.ingest(observation({
      profile_id: "known-b",
      session_id: "known-session",
      provider_subject: SUBJECT_B,
      sequence: 1,
      sampled_at: "2026-08-15T14:59:00Z",
      observed_at: "2026-08-15T14:59:01Z",
      pool_label: "Claude · Pool B",
      windows: windows(0.4),
    }), "2026-08-15T14:59:02Z");
    const subjectPoolId = initial.snapshot("2026-08-15T14:59:03Z").pools[0]?.id;
    if (!subjectPoolId) throw new Error("known subject pool was not projected");
    initial.close();

    await writeFile(join(dir, "usage.json"), JSON.stringify([{
      account: {
        id: "legacy-b",
        label: "Claude · Legacy B",
        provider: "claude",
        source_host: "old-edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(0.41),
      },
      received_at: "2026-08-15T15:00:01Z",
    }]), "utf8");

    const store = await openStore(dir);
    expect(store.snapshot("2026-08-15T15:00:02Z").pools).toHaveLength(2);
    const result = store.ingest(observation({
      profile_id: "new-live-profile",
      session_id: "new-live-session",
      provider_subject: SUBJECT_B,
      identity_evidence: "org_email",
      sequence: 1,
      sampled_at: "2026-08-15T15:01:00Z",
      observed_at: "2026-08-15T15:01:01Z",
      pool_label: "Claude · Pool B",
      windows: windows(0.42),
    }), "2026-08-15T15:01:02Z");

    expect(result.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T15:01:03Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.id).toBe(subjectPoolId);
    expect(snapshot.pools[0]?.profiles.map((profile) => profile.id).sort())
      .toEqual(["known-b", "legacy-b", "new-live-profile"]);
    store.close();
  });

  test("multiple coincident schema-2 candidates remain ambiguous without a bound profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-ambiguous-import-"));
    const initial = await openStore(dir);
    initial.ingest(observation({
      profile_id: "known-b",
      session_id: "known-session",
      provider_subject: SUBJECT_B,
      sequence: 1,
      sampled_at: "2026-08-15T14:59:00Z",
      observed_at: "2026-08-15T14:59:01Z",
      windows: windows(0.4),
    }), "2026-08-15T14:59:02Z");
    initial.close();

    const legacyAccount = (id: string) => ({
      account: {
        id,
        label: `Claude · ${id}`,
        provider: "claude",
        source_host: "old-edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(0.41),
      },
    });
    await writeFile(
      join(dir, "usage.json"),
      JSON.stringify([legacyAccount("legacy-one"), legacyAccount("legacy-two")]),
      "utf8",
    );

    const store = await openStore(dir);
    expect(store.snapshot("2026-08-15T15:00:02Z").pools).toHaveLength(3);
    store.ingest(observation({
      profile_id: "new-live-profile",
      session_id: "new-live-session",
      provider_subject: SUBJECT_B,
      identity_evidence: "org_email",
      sequence: 1,
      sampled_at: "2026-08-15T15:01:00Z",
      observed_at: "2026-08-15T15:01:01Z",
      windows: windows(0.42),
    }), "2026-08-15T15:01:02Z");

    const snapshot = store.snapshot("2026-08-15T15:01:03Z");
    expect(snapshot.pools).toHaveLength(3);
    expect(snapshot.pools.filter((pool) => pool.identity_state === "provisional"))
      .toHaveLength(2);
    store.close();
  });

  test("cutover mode fails closed when required legacy state is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-required-missing-"));
    await expect(openStore(
      dir,
      DEFAULT_STORE_OPTIONS,
      { requireLegacyImport: true },
    )).rejects.toThrow(/required.*missing/);
  });

  test("completed required migration marker permits restart after importer removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-required-complete-"));
    await writeFile(join(dir, "usage.json"), "[]", "utf8");
    const first = await openStore(
      dir,
      DEFAULT_STORE_OPTIONS,
      { requireLegacyImport: true },
    );
    first.close();
    const second = await openStore(
      dir,
      DEFAULT_STORE_OPTIONS,
      { requireLegacyImport: true },
    );
    expect(second.snapshot("2026-08-15T15:00:00Z").pools).toEqual([]);
    second.close();
  });

  test("migrates an early schema-3 status constraint before accepting billing_unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-status-migration-"));
    const dbPath = join(dir, "usage-v3.sqlite");
    const old = new Database(dbPath, { create: true });
    old.exec(`
      CREATE TABLE pools (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
        subject_digest TEXT,
        label TEXT NOT NULL,
        identity_state TEXT NOT NULL CHECK (identity_state IN ('verified', 'provisional', 'conflict')),
        status TEXT NOT NULL CHECK (status IN ('ok', 'stale', 'auth_expired', 'error')),
        sampled_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        sample_quality TEXT NOT NULL,
        windows_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL UNIQUE
      );
      CREATE UNIQUE INDEX pools_by_subject
        ON pools(provider, subject_digest) WHERE subject_digest IS NOT NULL;
      CREATE TABLE bindings (
        profile_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
        label TEXT NOT NULL,
        source_host TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        binding_confidence TEXT NOT NULL,
        PRIMARY KEY (profile_id, session_key)
      );
      CREATE INDEX bindings_by_pool ON bindings(pool_id);
      INSERT INTO pools VALUES (
        'legacy-pool', 'claude', NULL, 'Claude · Legacy', 'provisional', 'ok',
        '2026-08-15T15:00:00.000Z', '2026-08-15T15:00:01.000Z',
        'unknown', '[]', '2026-08-15T15:00:01.000Z', 0
      );
      INSERT INTO bindings VALUES (
        'legacy-profile', '__profile__', 'claude', 'legacy-pool',
        'Legacy profile', 'legacy-host', '2026-08-15T15:00:00.000Z', 'provisional'
      );
      CREATE TABLE latest_session_observations (
        profile_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        observation_id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL,
        pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
        outcome TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (profile_id, session_key)
      );
      INSERT INTO latest_session_observations VALUES (
        'legacy-profile', '__profile__', '018f47f0-167a-7cc4-a3d1-d6f5eb04c4f3',
        7, 'legacy-pool', 'accepted', '2026-08-15T15:00:00.000Z',
        '2026-08-15T15:00:01.000Z', '{}'
      );
      PRAGMA user_version = 3;
    `);
    old.close();

    const store = await openStore(dir);
    expect(store.latestSessionObservationId("legacy-profile", null))
      .toBe("018f47f0-167a-7cc4-a3d1-d6f5eb04c4f3");
    expect(store.snapshot("2026-08-15T15:01:00Z").pools[0]?.id).toBe("legacy-pool");
    store.ingest(observation({
      provider: "grok",
      status: "billing_unavailable",
      windows: [],
    }), "2026-08-15T15:30:01Z");
    expect(store.snapshot("2026-08-15T15:31:00Z").pools
      .find((pool) => pool.provider === "grok")?.status)
      .toBe("billing_unavailable");
    store.close();

    const migrated = new Database(dbPath);
    expect(migrated.query<{ table: string }, []>(
      "PRAGMA foreign_key_list('latest_session_observations')",
    ).all().map((row) => row.table)).toEqual(["pools"]);
    expect(migrated.query<unknown, []>("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  test("corrupt legacy state terminalizes visibly instead of silently booting empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-corrupt-"));
    await writeFile(join(dir, "usage.json"), "{not-json", "utf8");
    await expect(openStore(dir)).rejects.toThrow(/corrupt.*not imported/);
  });

  test("validates every legacy entry before importing any projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-partial-corrupt-"));
    await writeFile(join(dir, "usage.json"), JSON.stringify([
      {
        account: {
          id: "valid-first",
          label: "Claude · Valid",
          provider: "claude",
          source_host: "edge",
          as_of: "2026-08-15T15:00:00Z",
          status: "ok",
          windows: windows(0.4),
        },
      },
      null,
    ]), "utf8");
    await expect(openStore(dir)).rejects.toThrow(/entry 1 must be an object/);
    const db = new Database(join(dir, "usage-v3.sqlite"));
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pools").get()?.count)
      .toBe(0);
    db.close();
  });

  test("rejects an unsupported explicit legacy provider before importing anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-provider-corrupt-"));
    const legacyPath = join(dir, "usage.json");
    await writeFile(legacyPath, JSON.stringify([{
      account: {
        id: "mystery-account",
        label: "Mystery",
        provider: "unknown",
        source_host: "edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(0.4),
      },
    }]), "utf8");

    await expect(openStore(dir)).rejects.toThrow(/account\.provider must be claude, codex, or grok/);
    const db = new Database(join(dir, "usage-v3.sqlite"));
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pools").get()?.count)
      .toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metadata").get()?.count)
      .toBe(0);
    db.close();
    expect((await stat(legacyPath)).isFile()).toBeTrue();
  });

  test("infers legacy provider only when the provider field is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-provider-inference-"));
    const legacyAccount = (id: string) => ({
      account: {
        id,
        label: id,
        source_host: "edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(0.4),
      },
    });
    await writeFile(
      join(dir, "usage.json"),
      JSON.stringify([legacyAccount("codex-work"), legacyAccount("team-claude")]),
      "utf8",
    );

    const store = await openStore(dir);
    const providers = new Map(store.snapshot("2026-08-15T15:01:00Z").pools.map((pool) => [
      pool.profiles[0]?.id,
      pool.provider,
    ]));
    expect(providers.get("codex-work")).toBe("codex");
    expect(providers.get("team-claude")).toBe("claude");
    store.close();
  });

  test("rolls back the complete legacy batch when capacity cannot admit it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-import-capacity-"));
    const legacyAccount = (id: string) => ({
      account: {
        id,
        label: `Claude · ${id}`,
        provider: "claude",
        source_host: "edge",
        as_of: "2026-08-15T15:00:00Z",
        status: "ok",
        windows: windows(0.4),
      },
    });
    await writeFile(
      join(dir, "usage.json"),
      JSON.stringify([legacyAccount("first"), legacyAccount("second")]),
      "utf8",
    );
    await expect(openStore(
      dir,
      { ...DEFAULT_STORE_OPTIONS, maxPools: 1 },
      { requireLegacyImport: true },
    )).rejects.toThrow(/pool limit/);
    const db = new Database(join(dir, "usage-v3.sqlite"));
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pools").get()?.count)
      .toBe(0);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metadata").get()?.count)
      .toBe(0);
    db.close();
    expect((await stat(join(dir, "usage.json"))).isFile()).toBeTrue();
  });

  test("refuses to create more than the configured pool limit", async () => {
    const { store } = await freshStore({ maxPools: 1 });
    store.ingest(observation({ profile_id: "a", provider_subject: SUBJECT_A }), "2026-08-15T15:30:01Z");
    expect(() => store.ingest(observation({
      profile_id: "b",
      provider_subject: SUBJECT_B,
      sequence: 1,
    }), "2026-08-15T15:30:02Z")).toThrow(StoreCapacityError);
    expect(store.snapshot("2026-08-15T15:31:00Z").pools).toHaveLength(1);
    store.close();
  });
});

describe("pool identity convergence", () => {
  const R1 = "2026-08-15T18:00:00.000Z";
  const R2 = "2026-08-15T19:30:00.000Z";

  test("a new session without subject evidence reuses the profile's bound pool instead of minting a twin", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-2",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.52, R1),
    }), "2026-08-15T15:31:02Z");

    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(1);
    const profile = snapshot.pools[0]?.profiles.find((entry) => entry.id === "profile-a");
    expect(profile?.binding_confidence).toBe("profile_history");
    expect(snapshot.pools[0]?.windows[0]?.utilization).toBe(0.52);
    store.close();
  });

  test("a subjectless re-login does not overwrite a verified subject pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      pool_label: "Claude · Account A",
      sequence: 1,
      windows: windows(0.4, R1),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-2",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      sampled_at: "2026-08-15T18:30:00Z",
      observed_at: "2026-08-15T18:30:01Z",
      pool_label: "Claude · Account B",
      windows: windows(0.9, "2026-08-15T23:00:00.000Z"),
    }), "2026-08-15T18:30:02Z");

    expect(result.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T18:31:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const verified = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(verified?.identity_state).toBe("verified");
    expect(verified?.label).toBe("Claude · Account A");
    expect(verified?.windows[0]?.utilization).toBe(0.4);
    expect(verified?.windows[0]?.resets_at).toBe(R1);
    const minted = snapshot.pools.find((pool) => !pool.id.endsWith(SUBJECT_A));
    expect(minted?.identity_state).toBe("provisional");
    expect(minted?.windows[0]?.utilization).toBe(0.9);
    store.close();
  });

  test("a subjectless new session that cannot continue the carrier mints instead of recording invalid_reset", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-0",
      provider_subject: SUBJECT_A,
      pool_label: "Claude · Account A",
      sequence: 1,
      windows: windows(0.4, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.3, R2),
    }), "2026-08-15T15:31:02Z");

    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const subjectPool = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(subjectPool?.windows[0]?.utilization).toBe(0.4);
    expect(subjectPool?.windows[0]?.resets_at).toBe(R1);
    const minted = snapshot.pools.find((pool) => !pool.id.endsWith(SUBJECT_A));
    expect(minted).toBeDefined();
    expect(minted?.windows[0]?.utilization).toBe(0.3);
    expect(minted?.windows[0]?.resets_at).toBe(R2);
    store.close();
  });

  test("a stale profile-history carrier does not bind a new session even when windows continue", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      sequence: 1,
      windows: windows(0.4, R1),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-2",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      sampled_at: "2026-08-15T15:46:00Z",
      observed_at: "2026-08-15T15:46:01Z",
      windows: windows(0.42, R1),
    }), "2026-08-15T15:46:02Z");

    expect(result.outcome).toBe("accepted");
    const snapshot = store.snapshot("2026-08-15T15:47:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const verified = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(verified?.windows[0]?.utilization).toBe(0.4);
    expect(verified?.identity_state).toBe("verified");
    store.close();
  });

  test("a heartbeat without windows still never binds a new session", async () => {
    const { store, dir } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    const result = store.ingest(observation({
      profile_id: "profile-a",
      session_id: "session-2",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      status: "auth_expired",
      windows: [],
    }), "2026-08-15T15:31:02Z");

    expect(result.outcome).toBe("ignored");
    expect(store.snapshot("2026-08-15T15:32:00Z").pools).toHaveLength(1);
    store.close();
    const db = new Database(join(dir, "usage-v3.sqlite"));
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM bindings WHERE session_key = 'session-2'",
    ).get()?.count).toBe(0);
    db.close();
  });

  test("a subjectless twin retires into the subject pool even after the subject pool was conflict-marked", async () => {
    const { store } = await freshStore();
    // W: an unrelated verified pool whose windows the conflict-maker continues.
    store.ingest(observation({
      profile_id: "profile-w",
      provider_subject: SUBJECT_B,
      sequence: 1,
      pool_label: "Claude · Pool W",
      windows: windows(0.9, R2),
    }), "2026-08-15T15:30:01Z");
    // V: the subject pool the twin should eventually merge into.
    store.ingest(observation({
      profile_id: "profile-y",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:02Z");
    // A stale A hint whose windows exactly continue W marks V as conflict
    // (the Anthropic #81231 rule).
    store.ingest(observation({
      profile_id: "profile-z",
      provider_subject: SUBJECT_A,
      sequence: 1,
      sampled_at: "2026-08-15T15:30:30Z",
      observed_at: "2026-08-15T15:30:31Z",
      pool_label: "stale-hint",
      windows: windows(0.92, R2),
    }), "2026-08-15T15:30:32Z");
    // A subjectless observer of V's quota mints a provisional twin.
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");
    expect(store.snapshot("2026-08-15T15:31:30Z").pools).toHaveLength(3);

    // Subject evidence arrives for the twin's profile. The subject pool being
    // in conflict state must not deadlock the retirement.
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.6, R1),
    }), "2026-08-15T15:32:02Z");

    const snapshot = store.snapshot("2026-08-15T15:33:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const poolV = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(poolV?.windows[0]?.utilization).toBe(0.6);
    expect(poolV?.identity_state).toBe("conflict");
    expect(poolV?.profiles.find((entry) => entry.id === "profile-x")?.binding_confidence)
      .toBe("subject");
    store.close();
  });

  test("a conflict-state twin still retires into the subject pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");
    // A brief second session of the twin's profile on another account is what
    // writes concurrent_session_ambiguity and flips the twin to conflict.
    const ambiguity = store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-2",
      provider_subject: SUBJECT_B,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:10Z",
      observed_at: "2026-08-15T15:31:11Z",
      pool_label: "Claude · Account B",
      windows: windows(0.2, R2),
    }), "2026-08-15T15:31:12Z");
    expect(ambiguity.outcome).toBe("conflict");
    const before = store.snapshot("2026-08-15T15:31:20Z");
    expect(before.pools).toHaveLength(3);
    expect(before.pools.find((pool) => !pool.id.endsWith(SUBJECT_A) && !pool.id.endsWith(SUBJECT_B))
      ?.identity_state).toBe("conflict");

    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.6, R1),
    }), "2026-08-15T15:32:02Z");

    const snapshot = store.snapshot("2026-08-15T15:33:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.some((pool) =>
      !pool.id.endsWith(SUBJECT_A) && !pool.id.endsWith(SUBJECT_B)
    )).toBeFalse();
    const poolV = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(poolV?.windows[0]?.utilization).toBe(0.6);
    expect(poolV?.identity_state).toBe("conflict");
    expect(poolV?.profiles.find((entry) => entry.id === "profile-x")?.binding_confidence)
      .toBe("subject");
    store.close();
  });

  test("a stale concurrent-session contradiction restores verified on a later observation", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");
    const ambiguity = store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-2",
      provider_subject: SUBJECT_B,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:10Z",
      observed_at: "2026-08-15T15:31:11Z",
      pool_label: "Claude · Account B",
      windows: windows(0.2, R2),
    }), "2026-08-15T15:31:12Z");
    expect(ambiguity.outcome).toBe("conflict");

    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.6, R1),
    }), "2026-08-15T15:32:02Z");

    const afterRetirement = store.snapshot("2026-08-15T15:33:00Z");
    expect(afterRetirement.pools).toHaveLength(2);
    expect(afterRetirement.pools.find((pool) => pool.id.endsWith(SUBJECT_A))?.identity_state)
      .toBe("conflict");
    expect(afterRetirement.pools.find((pool) => pool.id.endsWith(SUBJECT_B))?.identity_state)
      .toBe("conflict");

    // B has been quiet since 15:31:11. CURRENT_PROFILE_MS is 15 minutes;
    // two hours later the contradiction is stale, but only a later
    // observation of V can re-ask the restore predicate.
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      sequence: 4,
      sampled_at: "2026-08-15T17:32:00Z",
      observed_at: "2026-08-15T17:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.61, R1),
    }), "2026-08-15T17:32:02Z");

    const snapshot = store.snapshot("2026-08-15T17:33:00Z");
    expect(snapshot.pools).toHaveLength(2);
    expect(snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A))?.identity_state)
      .toBe("verified");
    expect(snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B))?.identity_state)
      .toBe("conflict");
    store.close();
  });

  test("a conflict-state twin still promotes when the subject first appears", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    const ambiguity = store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-2",
      provider_subject: SUBJECT_B,
      sequence: 2,
      sampled_at: "2026-08-15T15:30:10Z",
      observed_at: "2026-08-15T15:30:11Z",
      pool_label: "Claude · Account B",
      windows: windows(0.2, R2),
    }), "2026-08-15T15:30:12Z");
    expect(ambiguity.outcome).toBe("conflict");
    const twinId = store.snapshot("2026-08-15T15:30:20Z")
      .pools.find((pool) => !pool.id.endsWith(SUBJECT_B))?.id;
    expect(twinId).toBeDefined();

    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "Claude · Account A",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");

    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(2);
    const promoted = snapshot.pools.find((pool) => pool.id === twinId);
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(promoted?.identity_state).toBe("conflict");
    expect(promoted?.label).toBe("Claude · Account A");
    expect(promoted?.windows[0]?.utilization).toBe(0.55);
    expect(poolB?.identity_state).toBe("conflict");
    store.close();
  });

  test("retiring a twin restores verified when remaining conflict rows only name the subject pool", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.6, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");
    expect(store.snapshot("2026-08-15T15:31:30Z").pools).toHaveLength(2);

    // Regression against V redirects onto the twin and conflict-marks V with
    // an identity_hint_conflict that names the twin — the production split.
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:32:02Z");
    expect(store.snapshot("2026-08-15T15:32:30Z")
      .pools.find((pool) => pool.id.endsWith(SUBJECT_A))?.identity_state)
      .toBe("conflict");

    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:33:00Z",
      observed_at: "2026-08-15T15:33:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.65, R1),
    }), "2026-08-15T15:33:02Z");

    const snapshot = store.snapshot("2026-08-15T15:34:00Z");
    expect(snapshot.pools).toHaveLength(1);
    const poolV = snapshot.pools[0];
    expect(poolV?.id.endsWith(SUBJECT_A)).toBeTrue();
    expect(poolV?.identity_state).toBe("verified");
    expect(poolV?.windows[0]?.utilization).toBe(0.65);
    store.close();
  });

  test("a quota regression row does not permanently block identity restore", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      session_id: "session-1",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.6, R1),
    }), "2026-08-15T15:30:01Z");
    // Same session, subjectless, lower util: recordConflict(regression, NULL, V).
    const regression = store.ingest(observation({
      profile_id: "profile-y",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 2,
      sampled_at: "2026-08-15T15:30:30Z",
      observed_at: "2026-08-15T15:30:31Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:32Z");
    expect(regression.outcome).toBe("conflict");

    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:32:02Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:33:00Z",
      observed_at: "2026-08-15T15:33:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.65, R1),
    }), "2026-08-15T15:33:02Z");

    const snapshot = store.snapshot("2026-08-15T15:34:00Z");
    const poolV = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(poolV?.identity_state).toBe("verified");
    expect(poolV?.windows[0]?.utilization).toBe(0.65);
    store.close();
  });

  test("an unparseable ambiguity row for another pool does not block restore", async () => {
    const { store, dir } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.6, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");
    store.close();

    const db = new Database(join(dir, "usage-v3.sqlite"));
    db.query(`
      INSERT INTO conflicts (
        observation_id, profile_id, kind, hinted_pool_id, matched_pool_id,
        created_at, evidence_json
      ) VALUES (?, ?, 'concurrent_session_ambiguity', NULL, NULL, ?, ?)
    `).run("unrelated-obs", "unrelated-profile", "2026-08-15T15:31:03Z", "{not json");
    db.close();

    const reopened = await openStore(dir, DEFAULT_STORE_OPTIONS);
    reopened.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:32:02Z");
    reopened.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 3,
      sampled_at: "2026-08-15T15:33:00Z",
      observed_at: "2026-08-15T15:33:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.65, R1),
    }), "2026-08-15T15:33:02Z");

    const snapshot = reopened.snapshot("2026-08-15T15:34:00Z");
    expect(snapshot.pools).toHaveLength(1);
    expect(snapshot.pools[0]?.identity_state).toBe("verified");
    reopened.close();
  });

  test("an unparseable ambiguity row that names the pool stays a loud scoped block", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const { store, dir } = await freshStore();
    try {
      store.ingest(observation({
        profile_id: "profile-y",
        provider_subject: SUBJECT_A,
        sequence: 1,
        pool_label: "Claude · Pool V",
        windows: windows(0.6, R1),
      }), "2026-08-15T15:30:01Z");
      store.ingest(observation({
        profile_id: "profile-x",
        provider_subject: null,
        identity_evidence: "unknown",
        sequence: 1,
        sampled_at: "2026-08-15T15:31:00Z",
        observed_at: "2026-08-15T15:31:01Z",
        windows: windows(0.55, R1),
      }), "2026-08-15T15:31:02Z");
      const poolVId = store.snapshot("2026-08-15T15:31:30Z")
        .pools.find((pool) => pool.id.endsWith(SUBJECT_A))?.id;
      expect(poolVId).toBeDefined();
      store.close();

      const db = new Database(join(dir, "usage-v3.sqlite"));
      db.query(`
        INSERT INTO conflicts (
          observation_id, profile_id, kind, hinted_pool_id, matched_pool_id,
          created_at, evidence_json
        ) VALUES (?, ?, 'concurrent_session_ambiguity', NULL, NULL, ?, ?)
      `).run(
        "broken-obs",
        "profile-y",
        "2026-08-15T15:31:03Z",
        `{not json but names ${poolVId}`,
      );
      db.close();

      const reopened = await openStore(dir, DEFAULT_STORE_OPTIONS);
      reopened.ingest(observation({
        profile_id: "profile-x",
        provider_subject: SUBJECT_A,
        sequence: 2,
        sampled_at: "2026-08-15T15:32:00Z",
        observed_at: "2026-08-15T15:32:01Z",
        pool_label: "Claude · Pool V",
        windows: windows(0.55, R1),
      }), "2026-08-15T15:32:02Z");
      reopened.ingest(observation({
        profile_id: "profile-x",
        provider_subject: SUBJECT_A,
        sequence: 3,
        sampled_at: "2026-08-15T15:33:00Z",
        observed_at: "2026-08-15T15:33:01Z",
        pool_label: "Claude · Pool V",
        windows: windows(0.65, R1),
      }), "2026-08-15T15:33:02Z");

      const snapshot = reopened.snapshot("2026-08-15T15:34:00Z");
      expect(snapshot.pools[0]?.identity_state).toBe("conflict");
      expect(errors.some((line) =>
        line.includes("unparseable concurrent_session_ambiguity") &&
        line.includes(poolVId ?? "")
      )).toBeTrue();
      reopened.close();
    } finally {
      console.error = original;
    }
  });

  test("concurrent-session ambiguity keeps the conflict through an unrelated twin retirement", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      session_id: "session-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Account A",
      windows: windows(0.4, R1),
    }), "2026-08-15T15:30:01Z");
    const ambiguity = store.ingest(observation({
      profile_id: "profile-y",
      session_id: "session-b",
      provider_subject: SUBJECT_B,
      sequence: 2,
      sampled_at: "2026-08-15T15:30:30Z",
      observed_at: "2026-08-15T15:30:31Z",
      pool_label: "Claude · Account B",
      windows: windows(0.2, R2),
    }), "2026-08-15T15:30:32Z");
    expect(ambiguity.outcome).toBe("conflict");
    expect(store.snapshot("2026-08-15T15:30:45Z").pools.every((pool) =>
      pool.identity_state === "conflict"
    )).toBeTrue();

    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      windows: windows(0.45, R1),
    }), "2026-08-15T15:31:02Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:32:00Z",
      observed_at: "2026-08-15T15:32:01Z",
      pool_label: "Claude · Account A",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:32:02Z");

    const snapshot = store.snapshot("2026-08-15T15:33:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.identity_state).toBe("conflict");
    expect(poolB?.identity_state).toBe("conflict");
    store.close();
  });

  test("a stale concurrent-session ambiguity does not block restore", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      session_id: "session-a",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Account A",
      windows: windows(0.4, R1),
    }), "2026-08-15T15:30:01Z");
    const ambiguity = store.ingest(observation({
      profile_id: "profile-y",
      session_id: "session-b",
      provider_subject: SUBJECT_B,
      sequence: 2,
      sampled_at: "2026-08-15T15:30:30Z",
      observed_at: "2026-08-15T15:30:31Z",
      pool_label: "Claude · Account B",
      windows: windows(0.2, R2),
    }), "2026-08-15T15:30:32Z");
    expect(ambiguity.outcome).toBe("conflict");

    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:46:00Z",
      observed_at: "2026-08-15T15:46:01Z",
      windows: windows(0.45, R1),
    }), "2026-08-15T15:46:02Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:46:30Z",
      observed_at: "2026-08-15T15:46:31Z",
      pool_label: "Claude · Account A",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:46:32Z");

    const snapshot = store.snapshot("2026-08-15T15:47:00Z");
    const poolA = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    const poolB = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_B));
    expect(poolA?.identity_state).toBe("verified");
    expect(poolB?.identity_state).toBe("conflict");
    store.close();
  });

  test("a window-continuity binding to a subjectless twin merges when subject and windows both corroborate", async () => {
    const { store, dir } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-y",
      provider_subject: SUBJECT_A,
      sequence: 1,
      pool_label: "Claude · Pool V",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    store.ingest(observation({
      profile_id: "profile-x",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:30:30Z",
      observed_at: "2026-08-15T15:30:31Z",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:32Z");
    store.close();

    // Arrange the recorded production state: the twin's binding hardened to
    // window-continuity confidence (reachable through merge/import histories).
    const db = new Database(join(dir, "usage-v3.sqlite"));
    db.query(
      "UPDATE bindings SET binding_confidence = 'window_continuity' WHERE profile_id = 'profile-x'",
    ).run();
    db.close();

    const reopened = await openStore(dir, DEFAULT_STORE_OPTIONS);
    const result = reopened.ingest(observation({
      profile_id: "profile-x",
      provider_subject: SUBJECT_A,
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "Claude · Pool V",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");

    expect(result.outcome).not.toBe("conflict");
    const snapshot = reopened.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(1);
    const poolV = snapshot.pools[0];
    expect(poolV?.id.endsWith(SUBJECT_A)).toBeTrue();
    expect(poolV?.identity_state).toBe("verified");
    expect(poolV?.windows[0]?.utilization).toBe(0.55);
    expect(poolV?.profiles.find((entry) => entry.id === "profile-x")?.binding_confidence)
      .toBe("subject");
    expect(reopened.conflictCount()).toBe(0);
    reopened.close();
  });

  test("coincident conflict and provisional twins stay ambiguous instead of promoting", async () => {
    const { store } = await freshStore();
    store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-1",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:01Z");
    const ambiguity = store.ingest(observation({
      profile_id: "profile-x",
      session_id: "session-2",
      provider_subject: SUBJECT_B,
      sequence: 2,
      sampled_at: "2026-08-15T15:30:10Z",
      observed_at: "2026-08-15T15:30:11Z",
      pool_label: "Claude · Account B",
      windows: windows(0.2, R2),
    }), "2026-08-15T15:30:12Z");
    expect(ambiguity.outcome).toBe("conflict");
    store.ingest(observation({
      profile_id: "profile-z",
      session_id: "session-z",
      provider_subject: null,
      identity_evidence: "unknown",
      sequence: 1,
      sampled_at: "2026-08-15T15:30:20Z",
      observed_at: "2026-08-15T15:30:21Z",
      windows: windows(0.5, R1),
    }), "2026-08-15T15:30:22Z");
    const before = store.snapshot("2026-08-15T15:30:30Z");
    expect(before.pools).toHaveLength(3);
    const conflictTwinId = before.pools.find((pool) =>
      !pool.id.endsWith(SUBJECT_B) && pool.identity_state === "conflict"
    )?.id;
    const provisionalTwinId = before.pools.find((pool) =>
      pool.identity_state === "provisional"
    )?.id;
    expect(conflictTwinId).toBeDefined();
    expect(provisionalTwinId).toBeDefined();

    store.ingest(observation({
      profile_id: "profile-w",
      session_id: "session-w",
      provider_subject: SUBJECT_A,
      sequence: 1,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:01Z",
      pool_label: "Claude · Account A",
      windows: windows(0.55, R1),
    }), "2026-08-15T15:31:02Z");

    const snapshot = store.snapshot("2026-08-15T15:32:00Z");
    expect(snapshot.pools).toHaveLength(4);
    const promoted = snapshot.pools.find((pool) => pool.id === provisionalTwinId);
    const conflictTwin = snapshot.pools.find((pool) => pool.id === conflictTwinId);
    const fresh = snapshot.pools.find((pool) => pool.id.endsWith(SUBJECT_A));
    expect(promoted?.identity_state).toBe("provisional");
    expect(conflictTwin?.identity_state).toBe("conflict");
    expect(fresh?.identity_state).toBe("verified");
    expect(fresh?.id).not.toBe(provisionalTwinId);
    store.close();
  });
});
