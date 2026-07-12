export type ResearchLimits = {
  maxSteps: number;
  maxSearchRounds: number;
  maxResultsPerRound: number;
  maxSourcesToRead: number;
  requestTimeoutMs: number;
};

export const defaultResearchLimits: ResearchLimits = {
  maxSteps: 12,
  maxSearchRounds: 5,
  maxResultsPerRound: 6,
  maxSourcesToRead: 12,
  requestTimeoutMs: 30_000,
};

export const quickResearchLimits: ResearchLimits = {
  ...defaultResearchLimits,
  maxSteps: 8,
  maxSearchRounds: 2,
  maxSourcesToRead: 6,
};
