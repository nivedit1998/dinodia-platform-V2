const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const DEPLOYMENT_ID = /^dpl_[a-z0-9]+$/i;
const SOURCE_FINGERPRINT = /^[a-f0-9]{16,64}$/i;

export function safeBuildId(env = process.env) {
  const commit = String(env.VERCEL_GIT_COMMIT_SHA ?? '').trim();
  if (COMMIT_SHA.test(commit)) return commit.slice(0, 12).toLowerCase();

  const deployment = String(env.VERCEL_DEPLOYMENT_ID ?? '').trim();
  if (DEPLOYMENT_ID.test(deployment)) return deployment;

  if (env.VERCEL === '1' || env.VERCEL_ENV) return 'vercel-deployment-id-unavailable';

  const fingerprint = String(env.FOUNDATION_SOURCE_FINGERPRINT ?? '').trim();
  if (SOURCE_FINGERPRINT.test(fingerprint)) return fingerprint.slice(0, 16).toLowerCase();
  return 'local';
}
