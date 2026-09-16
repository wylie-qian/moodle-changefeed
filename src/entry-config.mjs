import path from 'node:path';
import { loadEntryPublicConfig, createEnvironmentCredentialProvider } from './config.mjs';
import { loadProfile, getAccountDataDir } from './auth/profiles.mjs';

export async function resolveEntryConfig({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const entry = loadEntryPublicConfig({ argv, env, cwd });
  let publicConfig = entry.publicConfig;
  if (publicConfig.profile) {
    const profile = await loadProfile({ name: publicConfig.profile, profileRoot: env.MOODLE_CHANGEFEED_PROFILE_ROOT, dataRoot: path.join(publicConfig.dataDir, "accounts") });
    if (entry.requestedSiteUrl && publicConfig.siteUrl !== profile.siteUrl) {
      throw new Error('Profile site does not match requested site; use a separate profile');
    }
    if (env.MOODLE_CHANGEFEED_TOKEN || env.MOODLE_CHANGEFEED_ICS_URL) {
      throw new Error('Do not mix a saved profile with environment credentials');
    }
    publicConfig = { ...publicConfig, siteUrl: profile.siteUrl, userId: profile.userId,
      dataDir: profile.dataDir, identityScoped: true, archiveRoot: getAccountDataDir({siteUrl: profile.siteUrl, userId: profile.userId, dataRoot: path.join(publicConfig.archiveRoot, "accounts")}),
      credentialStatus: { webServiceToken: 'configured', icsUrl: 'missing' } };
    return { publicConfig, requestedSiteUrl: profile.siteUrl, credentialProvider: profile.credentialProvider };
  }
  let credentialProvider = null;
  try {
    const provider = createEnvironmentCredentialProvider(env);
    if (provider.siteKey === publicConfig.siteUrl) credentialProvider = provider;
  } catch { /* Invalid sites remain a bounded bootstrap response, with no bound secrets. */ }
  credentialProvider ||= { siteKey: null, async getWebServiceToken() { return null; }, async getIcsUrl() { return null; } };
  return { ...entry, credentialProvider };
}
