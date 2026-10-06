/**
 * A call bound to one workspace found another one open (the owner switched while it waited).
 * Remote commands are checked against a workspace and audited under it, so they pass that
 * workspace down and the service throws this instead of acting on whatever is open now.
 */
export class WorkspaceChangedError extends Error {
  constructor() {
    super('The workspace open on the Mac changed; this command was not run.')
    this.name = 'WorkspaceChangedError'
  }
}
