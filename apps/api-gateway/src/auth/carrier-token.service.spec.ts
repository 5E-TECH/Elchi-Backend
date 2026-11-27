import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  CARRIER_TOKEN_AUDIENCE,
  CARRIER_TOKEN_TTL_SECONDS,
  CarrierTokenService,
} from './carrier-token.service';

const ACCESS_TOKEN_KEY =
  'f1e2d3c4b5a6978869504132a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const FP = 'c'.repeat(32);

const make = () => {
  const jwt = new JwtService({
    secret: ACCESS_TOKEN_KEY,
    signOptions: { expiresIn: '1h' },
  });
  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'ACCESS_TOKEN_KEY') throw new Error(key);
      return ACCESS_TOKEN_KEY;
    },
  } as unknown as ConfigService;
  return { jwt, tokens: new CarrierTokenService(config, jwt) };
};

describe('CarrierTokenService (Olcha uslubidagi JWT)', () => {
  afterEach(() => jest.useRealTimers());

  it('Olcha AuthTokenResponse: Bearer, 3600 s; token o‘zi tekshiriladi', () => {
    const { tokens } = make();
    const issued = tokens.issue({ id: '3', token_fp: FP });
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(CARRIER_TOKEN_TTL_SECONDS).toBe(3600);
    expect(tokens.verify(issued.access_token)).toEqual({ sub: '3', kfp: FP });
  });

  it('⭐ xodim JWT kaliti (ACCESS_TOKEN_KEY) carrier tokenini TASDIQLAMAYDI — xodim API’siga kirmaydi', () => {
    const { jwt, tokens } = make();
    const { access_token } = tokens.issue({ id: '3', token_fp: FP });
    expect(() => jwt.verify(access_token)).toThrow();
  });

  it('⭐ xodim (kurier) tokeni carrier tokeni sifatida o‘tmaydi', () => {
    const { jwt, tokens } = make();
    const staff = jwt.sign({ sub: '55', roles: ['courier'] });
    expect(tokens.verify(staff)).toBeNull();
  });

  it('muddati o‘tgan token — null (1 soatdan keyin)', () => {
    jest.useFakeTimers({ now: new Date('2026-11-27T00:00:00Z') });
    const { tokens } = make();
    const { access_token } = tokens.issue({ id: '3', token_fp: FP });
    jest.setSystemTime(new Date('2026-11-27T01:00:01Z'));
    expect(tokens.verify(access_token)).toBeNull();
  });

  it('boshqa audience yoki typ’siz token — null; soxta matn — null', () => {
    const { jwt, tokens } = make();
    const key = (tokens as unknown as { key: string }).key;
    const wrongAud = jwt.sign(
      { kfp: FP, typ: 'carrier' },
      { secret: key, audience: 'other', subject: '3' },
    );
    const noTyp = jwt.sign(
      { kfp: FP },
      { secret: key, audience: CARRIER_TOKEN_AUDIENCE, subject: '3' },
    );
    expect(tokens.verify(wrongAud)).toBeNull();
    expect(tokens.verify(noTyp)).toBeNull();
    expect(tokens.verify('x.y.z')).toBeNull();
  });
});
