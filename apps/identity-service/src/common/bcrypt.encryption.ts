import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcryptjs';

const SALT_OR_ROUNDS = 10;

@Injectable()
export class BcryptEncryption {
  async encrypt(password: string): Promise<string> {
    try {
      return await bcrypt.hash(password, SALT_OR_ROUNDS);
    } catch (error) {
      throw new RpcException({ statusCode: 400, message: `Error on encrypt: ${error}` });
    }
  }

  async compare(password: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, hash);
    } catch (error) {
      throw new RpcException({ statusCode: 400, message: `Error on compare: ${error}` });
    }
  }
}
