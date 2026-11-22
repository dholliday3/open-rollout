import type { Decision, FlagWrite } from "./decide";
import type { Ports, Stored } from "./ports";
import type { RolloutRecord } from "./record";
import { messageOf } from "./observe";
import { sameAllocation } from "./allocation";

/**
 * A write that failed is sent once more when the flag is exactly one revision on and its shares are still
 * what they were: one edit to something else about the flag, which is not a reason to hold a step. Two
 * revisions on may be this write landing with its answer lost and a person undoing it, so that is left for
 * the next tick to read. So is any change to the shares.
 */
async function writeAgain(ports: Ports, flagKey: string, write: FlagWrite): Promise<number | null> {
  const now = await ports.flags.read(flagKey);
  if (write.over === null || write.expectedRevision === undefined || now.revision !== write.expectedRevision + 1 || !sameAllocation(now.allocation, write.over)) {
    return null;
  }
  const revision = await ports.flags.write(flagKey, write.allocation, now.revision);
  return revision;
}

async function send(ports: Ports, flagKey: string, write: FlagWrite): Promise<number | null> {
  try {
    const revision = await ports.flags.write(flagKey, write.allocation, write.expectedRevision);
    return revision;
  } catch (error) {
    const revision = await writeAgain(ports, flagKey, write);
    if (revision === null) {
      throw error;
    }
    return revision;
  }
}

/**
 * Makes the decision's flag write, but only if the record is still the one this worker saved. A worker
 * that stalled between saving and writing finds a newer version and stands down. Returns the revision the
 * write left the flag at, or null when nothing was written.
 */
async function applyWrite(ports: Ports, decision: Decision, saved: { version: number; problems: string[] }): Promise<number | null> {
  const { record, write } = decision;
  try {
    const current = write === null ? null : await ports.store.load(record.id);
    if (write === null || current?.version !== saved.version) {
      return null;
    }
    const revision = await send(ports, record.plan.flagKey, write);
    return revision;
  } catch (error) {
    saved.problems.push(`Writing the flag failed: ${messageOf(error)}`);
    return null;
  }
}

/**
 * Notes the revision our own write left the flag at. From then on a reading below it is a read that is
 * behind. If this save loses a race nothing is lost: the next reading at that revision is simply new.
 */
async function acknowledge(ports: Ports, stored: Stored, revision: number): Promise<Stored> {
  const record: RolloutRecord = { ...stored.record, seenRevision: Math.max(stored.record.seenRevision ?? revision, revision) },
    version = await ports.store.save(record, stored.version);
  return version === null ? stored : { record, version };
}

export { acknowledge, applyWrite };
