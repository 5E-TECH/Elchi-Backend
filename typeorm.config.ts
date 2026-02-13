import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

export default new DataSource({
  type: 'postgres',
  url: process.env.POSTGRES_URI,
  schema: process.env.DB_SCHEMA || 'public',
  entities: ['apps/**/src/entities/*.entity.ts', 'dist/**/entities/*.entity.js'],
  migrations: ['migrations/*.ts', 'dist/migrations/*.js'],
  synchronize: false,
});
