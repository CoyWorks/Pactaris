export const workspaceActions=['workspaceRead','workspaceUnread','workspaceChanges','settingsUpdate','pointsConfigure','personalSeriesList','personalSeriesSave','personalSeriesStop','taskRead','taskCreate','taskUpdate','taskComplete','taskArchive','taskReopen','plannerRead','calendarMark'] as const;
export type WorkspaceAction=typeof workspaceActions[number];
export const isWorkspaceAction=(value:unknown):value is WorkspaceAction=>typeof value==='string'&&(workspaceActions as readonly string[]).includes(value);
