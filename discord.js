// bot.js
require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // keep private
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const TONKOTSU_BASE = process.env.TONKOTSU_BASE_URL; // e.g. https://tonkotsu.online
const ADMIN_SHARED_SECRET = process.env.ADMIN_SHARED_SECRET;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !TONKOTSU_BASE || !ADMIN_SHARED_SECRET) {
  throw new Error("Missing env vars for bot.");
}

async function tonkotsuApi(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${TONKOTSU_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Tonkotsu-Bot-Secret": ADMIN_SHARED_SECRET
    },
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const commands = [
  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete a Tonkotsu account (progressive cooldown/ban).")
    .addStringOption(o => o.setName("username").setDescription("Username").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Post a global announcement.")
    .addStringOption(o => o.setName("text").setDescription("Announcement text").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("banip")
    .setDescription("Temporarily block an IP from tonkotsu.online.")
    .addStringOption(o => o.setName("ip").setDescription("IP").setRequired(true))
    .addIntegerOption(o => o.setName("seconds").setDescription("Seconds (default 3600)").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("reports")
    .setDescription("Fetch latest moderation reports.")
    .addIntegerOption(o => o.setName("limit").setDescription("How many").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Slash commands registered.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("ready", () => console.log(`Bot online as ${client.user.tag}`));

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "delete") {
      await interaction.deferReply({ ephemeral: true });
      const username = interaction.options.getString("username", true);
      const r = await tonkotsuApi("/api/bot/deleteUser", { method: "POST", body: { username } });

      const untilText = r.permanent ? "permanent" : (r.until ? new Date(r.until).toLocaleString() : "none");
      await interaction.editReply(`Deleted ${username}. strikes=${r.strikes}, ban=${untilText}`);
      return;
    }

    if (interaction.commandName === "announce") {
      await interaction.deferReply({ ephemeral: true });
      const text = interaction.options.getString("text", true);
      await tonkotsuApi("/api/bot/announce", { method: "POST", body: { text } });
      await interaction.editReply("Announcement posted.");
      return;
    }

    if (interaction.commandName === "banip") {
      await interaction.deferReply({ ephemeral: true });
      const ip = interaction.options.getString("ip", true);
      const seconds = interaction.options.getInteger("seconds") ?? 3600;
      await tonkotsuApi("/api/bot/banIp", { method: "POST", body: { ip, seconds } });
      await interaction.editReply(`IP ${ip} blocked for ${seconds}s.`);
      return;
    }

    if (interaction.commandName === "reports") {
      await interaction.deferReply({ ephemeral: true });
      const limit = interaction.options.getInteger("limit") ?? 10;
      const r = await tonkotsuApi(`/api/bot/reports?limit=${encodeURIComponent(limit)}`, { method: "GET" });

      const reports = Array.isArray(r.reports) ? r.reports : [];
      if (!reports.length) {
        await interaction.editReply("No reports.");
        return;
      }

      // Summarize reports in an embed
      const emb = new EmbedBuilder()
        .setTitle("Tonkotsu Reports")
        .setDescription(reports.slice(-10).map(rep => {
          const t = new Date(rep.ts).toLocaleString();
          return `• [${t}] ${rep.reporter?.username}: msg=${rep.messageId} — ${rep.reason || "no reason"}`;
        }).join("\n"))
        .setColor(0xffd278);

      await interaction.editReply({ embeds: [emb] });
      return;
    }
  } catch (e) {
    await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
  }
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
