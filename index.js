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

let schedules = [];
let nextId = 1;

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "schedule") {
    const channel = interaction.options.getChannel("channel");
    const date = interaction.options.getString("date"); // DD-MM-YYYY
    const time = interaction.options.getString("time"); // HH:mm
    const message = interaction.options.getString("message");

    const [day, month, year] = date.split("-");
    const fullTime = `${year}-${month}-${day}T${time}:00`;

    const schedule = {
      id: nextId++,
      channelId: channel.id,
      channelName: channel.name,
      time: fullTime,
      displayDate: date,
      displayTime: time,
      message,
      sent: false,
    };

    schedules.push(schedule);

    await interaction.reply(
      `Scheduled message ID ${schedule.id} for ${date} ${time} London time in #${channel.name}`
    );
  }

  if (interaction.commandName === "list") {
    const active = schedules.filter((item) => !item.sent);

    if (active.length === 0) {
      await interaction.reply("No active scheduled messages.");
      return;
    }

    const list = active
      .map(
        (item) =>
          `ID ${item.id} — #${item.channelName} — ${item.displayDate} ${item.displayTime} — ${item.message.slice(
            0,
            80
          )}`
      )
      .join("\n");

    await interaction.reply("Active schedules:\n" + list);
  }

  if (interaction.commandName === "cancel") {
    const id = interaction.options.getInteger("id");

    const before = schedules.length;
    schedules = schedules.filter((item) => item.id !== id);

    if (schedules.length === before) {
      await interaction.reply(`No schedule found with ID ${id}.`);
      return;
    }

    await interaction.reply(`Cancelled schedule ID ${id}.`);
  }
});

cron.schedule("* * * * *", async () => {
  const now = new Date();

  for (const item of schedules) {
    if (item.sent) continue;

    const target = new Date(item.time + "+01:00");

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
      option.setName("date").setDescription("DD-MM-YYYY").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("time").setDescription("HH:mm").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("message").setDescription("Message").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("List active scheduled messages"),

  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Cancel a scheduled message")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("Schedule ID").setRequired(true)
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
