import { createBrowserLoginSession, consumeBrowserLoginCallback, readHiddenInput, readWebServiceToken } from '../auth/browser-login.mjs';
import { saveVerifiedProfile } from '../auth/profiles.mjs';
import { MoodleMobileClient } from '../adapters/moodle-mobile/index.mjs';
import { verifyMoodleCoreAccess } from '../entry-probe.mjs';

export async function login({ config, method = 'browser', env = process.env, input = process.stdin, output = process.stderr, fetchImpl = globalThis.fetch,
  readSecret = readHiddenInput, readToken = readWebServiceToken } = {}) {
  if (!config.profile || !config.siteUrl) throw new Error('login requires --profile <name> and --site-url <https-url>');
  if (!['browser', 'token'].includes(method)) throw new Error('login method must be browser or token');
  if (!input?.isTTY || !output?.isTTY) throw new Error('Run login in your own interactive terminal, not an agent tool. Never paste credentials into chat.');
  let token;
  if (method === 'browser') {
    const session = createBrowserLoginSession({siteUrl: config.siteUrl});
    output.write(`Open this link in your browser and complete your institution login/MFA:\n${session.launchUrl}\nThen COPY the "launch app" link on the success page and paste it below. Do not send it to chat.\n`);
    const callback = await readSecret({input, output, prompt: 'App callback (hidden): ', signal: AbortSignal.timeout(600000)});
    token = consumeBrowserLoginCallback(session, callback).webServiceToken;
  } else {
    output.write('Use a Web Service token supplied by your Moodle preferences or institution. This is not your password.\n');
    token = await readToken({input, output, prompt: 'Web Service token (hidden): '});
  }
  const credentialProvider = {siteKey: config.siteUrl, async getWebServiceToken() {return token;}};
  const connection = await verifyMoodleCoreAccess({siteUrl: config.siteUrl, credentialProvider, fetchImpl});
  if (!connection.canScan) throw new Error(`Credential was not saved: ${connection.status}. Check site permissions and retry login.`);
  const client = new MoodleMobileClient({siteKey: config.siteUrl, credentialProvider, fetchImpl});
  const info = await client.getSiteInfo();
  const profile = await saveVerifiedProfile({name: config.profile, siteUrl: config.siteUrl, userId: String(info.userid), token,
    profileRoot: env.MOODLE_CHANGEFEED_PROFILE_ROOT});
  return {connected: true, profile: profile.name, siteUrl: profile.siteUrl, userId: profile.userId,
    next: 'Start MCP with --profile ' + profile.name + ', then scan and search the library.'};
}
