export const routineActions=['routineList','routineRead','routineCreate','routineUpdate','routineActivate','routinePause','routineArchive','routineRestore','progressRecord','progressReverse','checkinList','checkinSubmit','checkinReview','checkinWithdraw'] as const;
export type RoutineAction=typeof routineActions[number];
export const isRoutineAction=(v:unknown):v is RoutineAction=>typeof v==='string'&&(routineActions as readonly string[]).includes(v);
