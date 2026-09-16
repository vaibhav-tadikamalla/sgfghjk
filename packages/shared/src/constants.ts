export const CURSOR_COLORS = [
  '#E57373', '#81C784', '#64B5F6', '#FFD54F',
  '#BA68C8', '#4DB6AC', '#FF8A65', '#A1887F',
  '#90A4AE', '#F06292', '#AED581', '#7986CB',
] as const;

export const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};

export const MAX_FILE_NAME_LENGTH = 255;
export const ACCESS_TOKEN_EXPIRY_SECONDS = 900; // 15 minutes
export const REFRESH_TOKEN_EXPIRY_DAYS = 30;
