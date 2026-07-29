export interface ResumeLoadingSnapshot {
  active: boolean;
  visible: boolean;
  monitoring: boolean;
  progress: number;
}

export interface ResumeLoadingProgressObserver {
  connectionReady: () => void;
  commandDispatching: () => void;
  outputWriteStarted: (outputChars: number) => void;
  outputWriteCompleted: (synchronizedFrameOpen: boolean) => void;
  skip: () => void;
  abort: () => void;
}

export const INACTIVE_RESUME_LOADING_SNAPSHOT: ResumeLoadingSnapshot = {
  active: false,
  visible: false,
  monitoring: false,
  progress: 0,
};
