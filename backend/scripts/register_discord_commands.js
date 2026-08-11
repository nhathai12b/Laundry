import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: '.env.production', override: false });

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function registerCommands() {
  const applicationId = getRequiredEnv('DISCORD_APP_ID');
  const botToken = getRequiredEnv('DISCORD_BOT_TOKEN');
  const guildId = process.env.DISCORD_GUILD_ID;

  const commands = [
    {
      name: 'bemy',
      description: 'XWASH management commands',
      options: [
        {
          type: 1,
          name: 'bao_cao_doanh_thu',
          description: 'Lay bao cao doanh thu hien tai',
        },
      ],
    },
  ];

  const url = guildId
    ? `${DISCORD_API_BASE_URL}/applications/${applicationId}/guilds/${guildId}/commands`
    : `${DISCORD_API_BASE_URL}/applications/${applicationId}/commands`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord command registration failed: ${response.status} ${body}`);
  }

  const result = await response.json();
  console.log(`Registered ${result.length} Discord command(s)${guildId ? ` for guild ${guildId}` : ' globally'}.`);
}

registerCommands().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
