import { z } from "zod";

export type ResearchLimits = {
  maxSteps: number;
  maxSearchRounds: number;
  maxResultsPerRound: number;
  maxSourcesToRead: number;
  requestTimeoutMs: number;
};

export const researchLimitsSchema = z.strictObject({
  maxSteps: z.number().finite().int().min(2).max(100),
  maxSearchRounds: z.number().finite().int().min(0).max(20),
  maxResultsPerRound: z.number().finite().int().min(0).max(20),
  maxSourcesToRead: z.number().finite().int().min(0).max(20),
  requestTimeoutMs: z.number().finite().int().positive().max(120_000),
});

export const defaultResearchLimits: ResearchLimits = {
  maxSteps: 12,
  maxSearchRounds: 5,
  maxResultsPerRound: 6,
  maxSourcesToRead: 12,
  requestTimeoutMs: 120_000,
};

export const quickResearchLimits: ResearchLimits = {
  ...defaultResearchLimits,
  maxSteps: 12,
  maxSearchRounds: 2,
  maxSourcesToRead: 6,
};
