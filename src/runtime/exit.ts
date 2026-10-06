/** Single authority for process exit codes. Defined here and nowhere else. */
export const EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  USER_ABORTED: 2,
  CONFIG_ERROR: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
