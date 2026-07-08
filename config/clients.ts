import * as line from '@line/bot-sdk';
import * as dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { dbClient } from './dbClient.js';

dotenv.config();

export const db = dbClient;

const hasDeepSeekKey = !!process.env.DEEPSEEK_API_KEY;

export const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: hasDeepSeekKey ? 'https://api.deepseek.com' : (process.env.OPENAI_BASE_URL || undefined),
});

export const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

export const lineClient = line.LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
});
