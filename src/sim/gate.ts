import type { Ports } from "../ports";

/**
 * Puts a gate in front of every port call, so a test or the scheduler decides when each one happens.
 * A worker (one `tick` or `command` call) runs until its next port call and parks there. Letting one
 * parked call through runs that worker up to its next one. That gives every interleaving of two or three
 * workers at every await point: park one between any two port calls and run another to completion in the
 * gap. A parked call that is never let through is a crashed worker; one let through much later is a zombie.
 */

type PortName = "flags.read" | "flags.write" | "metrics.snapshot" | "notifier.notify" | "store.create" | "store.listUnsettled" | "store.load" | "store.save";

/** One port call a worker is waiting on. */
interface Parked {
  readonly worker: string;
  readonly port: PortName;
  /** The worker's port calls so far, this one included: 1 for its first. */
  readonly sequence: number;
  /** Makes the call happen and hands its result to the worker. */
  readonly release: () => Promise<void>;
}

type Stop = PortName | ((call: Parked) => boolean) | null;

interface Gate {
  /** The same ports, but every call parks until it is let through. */
  readonly portsFor: (worker: string, ports: Ports) => Ports;
  readonly parked: () => readonly Parked[];
  /** Lets one parked call through and runs its worker to its next port call (or its end). */
  readonly pass: (call: Parked) => Promise<void>;
  /** Lets a worker's calls through, one after another, until it parks on a call `stop` accepts (not let through) or ends. */
  readonly runUntil: (worker: string, stop: Stop) => Promise<Parked | null>;
  /** Runs a worker to its end. */
  readonly finish: (worker: string) => Promise<void>;
  /** Forgets a worker's parked calls: it crashed, and nothing it was waiting on will ever happen. */
  readonly crash: (worker: string) => void;
}

/** The calls waiting at the gate, and how many each worker has made. */
interface Desk {
  waiting: Parked[];
  readonly counts: Map<string, number>;
}

interface Call {
  readonly worker: string;
  readonly port: PortName;
}

const TURNS = 60;

/** Lets every continuation that is ready run. The library awaits a handful of promises between port calls. */
async function settle(turns = TURNS): Promise<void> {
  if (turns <= 0) {
    return;
  }
  await Promise.resolve();
  await settle(turns - 1);
}

/** Parks a call: the promise it returns settles only when someone lets the call through. */
async function park<Value>(desk: Desk, call: Call, run: () => Promise<Value>): Promise<Value> {
  const sequence = (desk.counts.get(call.worker) ?? 0) + 1;
  desk.counts.set(call.worker, sequence);
  // eslint-disable-next-line promise/avoid-new -- a parked call is a promise someone else settles later; there is nothing to await yet
  const result = await new Promise<Value>((resolve, reject) => {
    const release = async (): Promise<void> => {
      try {
        resolve(await run());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    desk.waiting.push({ ...call, release, sequence });
  });
  return result;
}

/** The same call, but parked at the gate until it is let through. */
function behind<Given extends unknown[], Value>(desk: Desk, call: Call, run: (...given: Given) => Promise<Value>): (...given: Given) => Promise<Value> {
  return async (...given) => {
    const value = await park(desk, call, async () => {
      const result = await run(...given);
      return result;
    });
    return value;
  };
}

function gated(desk: Desk, worker: string, ports: Ports): Ports {
  return {
    flags: {
      read: behind(desk, { port: "flags.read", worker }, ports.flags.read),
      refusesStaleWrites: ports.flags.refusesStaleWrites,
      write: behind(desk, { port: "flags.write", worker }, ports.flags.write),
    },
    metrics: { snapshot: behind(desk, { port: "metrics.snapshot", worker }, ports.metrics.snapshot) },
    notifier: { notify: behind(desk, { port: "notifier.notify", worker }, ports.notifier.notify) },
    store: {
      create: behind(desk, { port: "store.create", worker }, ports.store.create),
      listUnsettled: behind(desk, { port: "store.listUnsettled", worker }, ports.store.listUnsettled),
      load: behind(desk, { port: "store.load", worker }, ports.store.load),
      save: behind(desk, { port: "store.save", worker }, ports.store.save),
    },
  };
}

function stops(call: Parked, stop: Stop): boolean {
  return typeof stop === "function" ? stop(call) : call.port === stop;
}

async function pass(desk: Desk, call: Parked): Promise<void> {
  desk.waiting = desk.waiting.filter((other) => other !== call);
  await call.release();
  await settle();
}

async function runUntil(desk: Desk, worker: string, stop: Stop): Promise<Parked | null> {
  await settle();
  const call = desk.waiting.find((waiting) => waiting.worker === worker);
  if (call === undefined || stops(call, stop)) {
    return call ?? null;
  }
  await pass(desk, call);
  const reached = await runUntil(desk, worker, stop);
  return reached;
}

function createGate(): Gate {
  const desk: Desk = { counts: new Map<string, number>(), waiting: [] };
  return {
    crash: (worker) => {
      desk.waiting = desk.waiting.filter((call) => call.worker !== worker);
    },
    finish: async (worker) => {
      await runUntil(desk, worker, null);
    },
    parked: () => desk.waiting,
    pass: async (call) => {
      await pass(desk, call);
    },
    portsFor: (worker, ports) => gated(desk, worker, ports),
    runUntil: async (worker, stop) => {
      const reached = await runUntil(desk, worker, stop);
      return reached;
    },
  };
}

export type { Gate, Parked, PortName };
export { createGate, settle };
