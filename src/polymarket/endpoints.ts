import { z } from "zod";

export const EndpointsSchema = z.object({
  gammaBaseUrl: z.string().url(),
  clobHost: z.string().url(),
  dataApiUrl: z.string().url(),
});

export type Endpoints = z.infer<typeof EndpointsSchema>;

