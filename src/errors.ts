/**
 * Thrown by module stubs that have not been built yet. Each carries the milestone
 * (docs/backlog.md) where it gets implemented, so a failing test points at the plan.
 */
export class NotImplementedError extends Error {
  constructor(
    readonly what: string,
    readonly milestone: string,
  ) {
    super(`${what} is not implemented yet (milestone ${milestone}, see docs/backlog.md)`);
    this.name = "NotImplementedError";
  }
}
