import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const dbConfig = {
  host: process.env.PG_HOST,
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : undefined,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
};

export const pool = new Pool(dbConfig);
