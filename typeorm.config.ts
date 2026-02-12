import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

export default new DataSource({
  type: 'postgres',
  url: process.env.POSTGRES_URI,
  entities: ['dist/**/entities/*.entity.js'],
  migrations: ['dist/migrations/*.js'],
  synchronize: false,
});
