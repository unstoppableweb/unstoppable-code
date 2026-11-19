const windowsArtifactSigningEnv = {
  endpoint: 'WINDOWS_ARTIFACT_SIGNING_ENDPOINT',
  codeSigningAccountName: 'WINDOWS_ARTIFACT_SIGNING_ACCOUNT_NAME',
  certificateProfileName: 'WINDOWS_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME',
  publisherName: 'WINDOWS_ARTIFACT_SIGNING_PUBLISHER_NAME',
};

export function getWindowsArtifactSigningOptions() {
  const required =
    process.env.WINDOWS_ARTIFACT_SIGNING_REQUIRED?.trim().toLowerCase() ===
    'true';
  const configuredValues = Object.fromEntries(
    Object.entries(windowsArtifactSigningEnv).map(([key, envName]) => [
      key,
      process.env[envName]?.trim() ?? '',
    ]),
  );
  const hasSigningMetadata = Object.values(configuredValues).some(Boolean);

  if (!required && !hasSigningMetadata) {
    return null;
  }

  const requiredEnvNames = [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    ...Object.values(windowsArtifactSigningEnv),
  ];
  const missing = requiredEnvNames.filter(
    (envName) => !process.env[envName]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Windows Artifact Signing configuration is incomplete. Missing: ${missing.join(', ')}`,
    );
  }

  let endpoint;
  try {
    endpoint = new URL(configuredValues.endpoint);
  } catch {
    throw new Error(
      'WINDOWS_ARTIFACT_SIGNING_ENDPOINT must be a valid HTTPS URL and must not include credentials, a path, query, or fragment.',
    );
  }
  const hasNonRootPath = endpoint.pathname.replace(/\/+$/, '') !== '';
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    hasNonRootPath ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'WINDOWS_ARTIFACT_SIGNING_ENDPOINT must be a valid HTTPS URL and must not include credentials, a path, query, or fragment.',
    );
  }

  return {
    ...configuredValues,
    endpoint: endpoint.origin,
    fileDigest: 'SHA256',
    timestampRfc3161: 'http://timestamp.acs.microsoft.com',
    timestampDigest: 'SHA256',
  };
}
