import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import gravatarUrl from 'gravatar-url';

/**
 * Single sign-on through a forward-auth reverse proxy (Authentik, Authelia,
 * oauth2-proxy...). Disabled unless AUTH_PROXY_HEADER is set. Only enable it
 * when MusicSeerr is reachable exclusively through that proxy, since anyone
 * who can reach the app directly could otherwise send the header themselves.
 *
 *   AUTH_PROXY_HEADER        header carrying the username (X-authentik-username)
 *   AUTH_PROXY_EMAIL_HEADER  optional header carrying the email (X-authentik-email)
 *   AUTH_PROXY_AUTO_CREATE   'true' to create unknown users with default permissions
 */
export const proxyAuthEnabled = (): boolean => !!process.env.AUTH_PROXY_HEADER;

const header = (
  headers: Record<string, string | string[] | undefined>,
  name: string | undefined
): string | undefined => {
  if (!name) {
    return undefined;
  }
  const value = headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
};

export const getProxyUser = async (
  headers: Record<string, string | string[] | undefined>
): Promise<User | null> => {
  const username = header(headers, process.env.AUTH_PROXY_HEADER);
  if (!username) {
    return null;
  }
  const email = header(headers, process.env.AUTH_PROXY_EMAIL_HEADER);

  const userRepository = getRepository(User);

  // Match the proxy identity to an existing account. Jellyfin users imported
  // through the LDAP plugin share their username with Authentik.
  const query = userRepository
    .createQueryBuilder('user')
    .where('LOWER(user.jellyfinUsername) = LOWER(:username)', { username })
    .orWhere('LOWER(user.username) = LOWER(:username)', { username })
    .orWhere('LOWER(user.plexUsername) = LOWER(:username)', { username })
    .orWhere('LOWER(user.email) = LOWER(:username)', { username });
  if (email) {
    query.orWhere('LOWER(user.email) = LOWER(:email)', { email });
  }
  const existing = await query.orderBy('user.id', 'ASC').getOne();

  if (existing) {
    return existing;
  }

  if (process.env.AUTH_PROXY_AUTO_CREATE !== 'true') {
    logger.warn('Proxy-authenticated user has no MusicSeerr account', {
      label: 'Auth',
      username,
    });
    return null;
  }

  const settings = getSettings();
  const userEmail = email ?? username;
  const user = new User({
    email: userEmail,
    username,
    avatar: gravatarUrl(userEmail, { default: 'mm', size: 200 }),
    permissions: settings.main.defaultPermissions,
    plexToken: '',
    userType: UserType.LOCAL,
  });
  await userRepository.save(user);

  logger.info('Created user from proxy authentication', {
    label: 'Auth',
    username,
    userId: user.id,
  });

  return user;
};
