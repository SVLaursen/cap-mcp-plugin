import { NotImplementedError } from "../errors";
import type { ExposureSpec, ToolSpec, UserLike } from "../types";

/**
 * exposure-registry (milestone M2)
 *
 * Builds the tool list from an ExposureSpec and filters it per request.
 *
 * Contract:
 * - Built once per model (cache keyed by model identity, so extended tenant models get their own).
 * - `toolsFor(user)` hides tools the user can never call (service/entity @requires), and returns
 *   tools in a deterministic order (the 2026-07-28 spec asks for that, for client caching).
 * - It is NOT the authorization boundary. CAP enforces @requires/@restrict when the executor
 *   runs the request; the registry only avoids advertising tools that would always be refused.
 * - Tool names are stable and predictable: <Service>_<Entity>_<mode>, <Service>_<operation>.
 * - Compact services (@mcp.compact) publish the generic tool set instead of per-entity tools.
 */
export class ExposureRegistry {
  constructor(private readonly spec: ExposureSpec) {}

  toolsFor(_user: UserLike): ToolSpec[] {
    void this.spec;
    throw new NotImplementedError("ExposureRegistry.toolsFor", "M2");
  }
}
