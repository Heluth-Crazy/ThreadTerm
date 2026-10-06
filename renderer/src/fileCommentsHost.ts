/** What a file view needs from its session workspace to send comments to an agent. SessionWorkspace provides it
 * through PaneWorkspace; views without it (project overview, settings, standalone workbench) show no comment UI. */

/** A session that can take a multi-line block in its Chat message box. */
export type CommentReceiver = { id: string; title: string; provider: string; root: string };

export type FileCommentsHost = {
  /** The registered folder of a project (worktree views pass their own worktreePath instead). */
  projectRoot: (projectId: string) => string | undefined;
  /** Working Chat sessions of this workspace's folder plus Chat sessions open in the workspace, current first. */
  receivers: CommentReceiver[];
  /** The workspace's current session, when it is one of `receivers`. */
  defaultReceiverId?: string;
  /** Inserts `text` into the session's message box without sending, opening its tab when needed. Rejects with a
   * readable (already localized) reason. */
  insert: (sessionId: string, text: string, images?: string[]) => Promise<void | number>;
  /** Shows a transfer outcome after the receiver tab becomes visible. */
  notice?: (text: string) => void;
};
