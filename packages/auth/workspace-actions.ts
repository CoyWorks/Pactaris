export const workspaceActions=['workspaceRead','workspaceUnread','settingsUpdate','pointsConfigure','taskRead','taskCreate','taskUpdate','taskComplete','taskArchive','taskReopen'] as const;
export type WorkspaceAction=typeof workspaceActions[number];
export const isWorkspaceAction=(value:unknown):value is WorkspaceAction=>typeof value==='string'&&(workspaceActions as readonly string[]).includes(value);
