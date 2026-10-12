import dotenv from 'dotenv';

// .env.local wins over .env (dotenv never overrides a variable that is already set).
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export interface GatewayConfig {
  nodeEnv: string;
  /** Port the gateway listens on. */
  port: number;
  /** Web frontend origin allowed by CORS. */
  frontendUrl: string;
  /** Candidate Profile Service REST base URL, no trailing slash. */
  candidateProfileUrl: string;
  /** Job Discovery Service REST base URL, no trailing slash. */
  jobDiscoveryUrl: string;
  /** Application Service REST base URL, no trailing slash. */
  applicationServiceUrl: string;
  /** Resume Preparation Service REST base URL, no trailing slash. */
  resumePreparationUrl: string;
  /** Job Posting Service gRPC address (host:port). */
  jobPostingGrpcUrl: string;
  /** Supabase project URL used to verify access tokens. */
  supabaseUrl: string;
  /** Supabase publishable key; never a service role key. */
  supabasePublishableKey: string;
}

/** Reads and validates the environment. Reports every problem at once. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const errors: string[] = [];
  const read = (name: string) => source[name]?.trim() ?? '';

  const required = (name: string) => {
    const value = read(name);
    if (value === '') errors.push(`${name} is required`);
    return value;
  };

  const httpUrl = (name: string) => {
    const value = required(name);
    if (value !== '' && !/^https?:\/\//.test(value)) {
      errors.push(`${name} must start with http:// or https:// (got "${value}")`);
    }
    return value.replace(/\/+$/, '');
  };

  const rawPort = read('PORT');
  const port = rawPort === '' ? 8080 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be a whole number between 1 and 65535 (got "${rawPort}")`);
  }

  const config: GatewayConfig = {
    nodeEnv: read('NODE_ENV') || 'development',
    port,
    frontendUrl: read('FRONTEND_URL') || 'http://localhost:3000',
    candidateProfileUrl: httpUrl('CANDIDATE_PROFILE_SERVICE_URL'),
    jobDiscoveryUrl: httpUrl('JOB_DISCOVERY_SERVICE_URL'),
    applicationServiceUrl: httpUrl('APPLICATION_SERVICE_URL'),
    resumePreparationUrl: httpUrl('RESUME_PREPARATION_SERVICE_URL'),
    jobPostingGrpcUrl: required('JOB_POSTING_GRPC_URL'),
    supabaseUrl: httpUrl('SUPABASE_URL'),
    supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
  };

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
