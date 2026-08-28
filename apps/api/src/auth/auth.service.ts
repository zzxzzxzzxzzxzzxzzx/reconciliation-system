import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'reconciliation_session';
const SESSION_DURATION_SECONDS = 12 * 60 * 60;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

type SessionPayload = {
  username: string;
  expiresAt: number;
  nonce: string;
};

type LoginAttempt = {
  count: number;
  firstFailedAt: number;
};

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, LoginAttempt>();

  login(username: string, password: string, clientKey: string) {
    this.assertConfigured();
    this.assertNotLocked(clientKey);

    const validUsername = this.safeTextEqual(username, process.env.ADMIN_USERNAME!);
    const validPassword = this.verifyPassword(password, process.env.ADMIN_PASSWORD_HASH!);
    if (!validUsername || !validPassword) {
      this.recordFailure(clientKey);
      throw new UnauthorizedException('用户名或密码不正确');
    }

    this.attempts.delete(clientKey);
    return {
      username: process.env.ADMIN_USERNAME!,
      token: this.createSessionToken(process.env.ADMIN_USERNAME!),
      maxAge: SESSION_DURATION_SECONDS,
    };
  }

  verifySession(cookieHeader?: string) {
    this.assertConfigured();
    const token = this.readCookie(cookieHeader, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('请先登录');

    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) throw new UnauthorizedException('登录状态无效，请重新登录');
    const expectedSignature = this.sign(encodedPayload);
    if (!this.safeTextEqual(signature, expectedSignature)) {
      throw new UnauthorizedException('登录状态无效，请重新登录');
    }

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SessionPayload;
      if (payload.expiresAt <= Date.now() || payload.username !== process.env.ADMIN_USERNAME) {
        throw new Error('expired');
      }
      return { username: payload.username };
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
  }

  sessionCookie(token: string, maxAge: number) {
    return [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      ...(process.env.COOKIE_SECURE === 'true' ? ['Secure'] : []),
    ].join('; ');
  }

  clearSessionCookie() {
    return [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      ...(process.env.COOKIE_SECURE === 'true' ? ['Secure'] : []),
    ].join('; ');
  }

  private createSessionToken(username: string) {
    const payload: SessionPayload = {
      username,
      expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000,
      nonce: randomBytes(16).toString('hex'),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  private sign(value: string) {
    return createHmac('sha256', process.env.SESSION_SECRET!).update(value).digest('base64url');
  }

  private verifyPassword(password: string, storedHash: string) {
    const [algorithm, salt, expectedHex] = storedHash.split('$');
    if (algorithm !== 'scrypt' || !salt || !expectedHex || !/^[a-f0-9]{128}$/i.test(expectedHex)) {
      throw new ServiceUnavailableException('管理员密码配置无效');
    }
    const actual = scryptSync(password, salt, 64);
    return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
  }

  private assertConfigured() {
    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH || !process.env.SESSION_SECRET) {
      throw new ServiceUnavailableException('管理员登录尚未配置');
    }
    if (process.env.SESSION_SECRET.length < 32) {
      throw new ServiceUnavailableException('会话密钥配置无效');
    }
  }

  private assertNotLocked(clientKey: string) {
    const attempt = this.attempts.get(clientKey);
    if (!attempt) return;
    if (Date.now() - attempt.firstFailedAt >= LOGIN_WINDOW_MS) {
      this.attempts.delete(clientKey);
      return;
    }
    if (attempt.count >= MAX_LOGIN_FAILURES) {
      throw new UnauthorizedException('登录失败次数过多，请 15 分钟后再试');
    }
  }

  private recordFailure(clientKey: string) {
    const current = this.attempts.get(clientKey);
    if (!current || Date.now() - current.firstFailedAt >= LOGIN_WINDOW_MS) {
      this.attempts.set(clientKey, { count: 1, firstFailedAt: Date.now() });
      return;
    }
    current.count += 1;
  }

  private readCookie(cookieHeader: string | undefined, name: string) {
    return cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  }

  private safeTextEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
