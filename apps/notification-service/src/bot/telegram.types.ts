/**
 * Telegram Bot API turlari — faqat yadro ishlatadigan maydonlar.
 * (ZlpXb4Wh) Telegraf/nestjs-telegraf QO'SHILMAYDI — xom fetch transporti.
 */
export interface TelegramChat {
  id: number | string;
  /** 'private' | 'group' | 'supergroup' | 'channel' */
  type?: string;
  title?: string;
}

export interface TelegramUser {
  id: number | string;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFile;
  video?: TelegramFile;
  /** (ysBqD9Nx) guruhga qo'shilgan a'zolar (servis xabari, matnsiz). */
  new_chat_members?: TelegramUser[];
  /** (BOT-3 #6) guruh supergroup'ga aylandi — yangi chat id (eski guruhda). */
  migrate_to_chat_id?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: TelegramUser;
  message?: TelegramMessage;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from?: TelegramUser;
  new_chat_member?: { status?: string; user?: TelegramUser };
  old_chat_member?: { status?: string; user?: TelegramUser };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdated;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramBotIdentity {
  id: number;
  is_bot: boolean;
  username?: string;
}

/** Bot API parse_mode qiymatlari (`Markdown` — eski, lekin hamon qo'llanadi). */
export type TelegramParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
