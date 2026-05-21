const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const cron = require("node-cron");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const schedules = [];

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "schedule") {
    const channel = interaction.options.getChannel("channel");
    const time = interaction.options.getString("time");
    const message = interaction.options.getString("message");

    schedules.push({
      channelId: channel.id,
      time,
      message,
      sent: false,
    });

    await interaction.reply(`Scheduled for ${time}`);
  }
});

cron.schedule("* * * * *", async () => {
  const now = new Date();

  for (const item of schedules) {
    if (item.sent) continue;

    const target = new Date(item.time);

    if (Math.abs(now - target) < 60000) {
      const channel = await client.channels.fetch(item.channelId);
      await channel.send(item.message);
      item.sent = true;
    }
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Schedule a message")
    .addChannelOption((option) =>
      option.setName("channel").setDescription("Channel").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("time").setDescription("2026-05-22T18:00:00").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("message").setDescription("Message").setRequired(true)
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });

    console.log("Commands registered");
  } catch (error) {
    console.error(error);
  }
})();

client.login(process.env.DISCORD_TOKEN);
