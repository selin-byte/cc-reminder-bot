const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
} = require("discord.js");

const cron = require("node-cron");
const { DateTime } = require("luxon");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let schedules = [];
let nextId = 1;
let serverTimezone = "Europe/London";

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

function parseDateTime(date, time) {
  let day, month, year;

  if (date.includes("-")) {
    [day, month, year] = date.split("-");
  } else if (date.includes("/")) {
    const parts = date.split("/");
    if (parts[0].length === 4) {
      [year, month, day] = parts;
    } else {
      [day, month, year] = parts;
    }
  }

  return DateTime.fromObject(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(time.split(":")[0]),
      minute: Number(time.split(":")[1]),
    },
    { zone: serverTimezone }
  );
}

async function sendScheduledMessage(item, type = "now") {
  const channel = await client.channels.fetch(item.channelId);

  const embed = new EmbedBuilder()
    .setTitle(type === "before" ? "⏰ Reminder: Creator College Call Soon" : "🚨 Happening Now")
    .setDescription(item.message)
    .addFields(
      { name: "Time", value: `${item.displayDate} ${item.displayTime} (${serverTimezone})`, inline: true },
      { name: "Channel", value: `#${item.channelName}`, inline: true }
    )
    .setTimestamp();

  if (item.imageUrl) {
    embed.setImage(item.imageUrl);
  }

  await channel.send({
    content: item.pingEveryone ? "@everyone" : "",
    embeds: [embed],
    allowedMentions: { parse: ["everyone", "roles"] },
  });
}

function advanceRecurringSchedule(item) {
  if (item.repeat === "daily") item.target = item.target.plus({ days: 1 });
  else if (item.repeat === "weekly") item.target = item.target.plus({ weeks: 1 });
  else if (item.repeat === "monthly") item.target = item.target.plus({ months: 1 });
  else item.sent = true;

  item.reminderSent = false;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "schedule") {
    const channel = interaction.options.getChannel("channel");
    const date = interaction.options.getString("date");
    const time = interaction.options.getString("time");
    const message = interaction.options.getString("message");
    const image = interaction.options.getAttachment("image");
    const repeat = interaction.options.getString("repeat") || "none";
    const oneHourBefore = interaction.options.getBoolean("one_hour_before") || false;
    const pingEveryone = interaction.options.getBoolean("ping_everyone") || false;

    const target = parseDateTime(date, time);

    if (!target.isValid) {
      await interaction.reply("Invalid date/time. Use date like `21-05-2026` and time like `14:30`.");
      return;
    }

    const schedule = {
      id: nextId++,
      channelId: channel.id,
      channelName: channel.name,
      displayDate: date,
      displayTime: time,
      message,
      imageUrl: image ? image.url : null,
      repeat,
      oneHourBefore,
      pingEveryone,
      target,
      sent: false,
      reminderSent: false,
    };

    schedules.push(schedule);

    await interaction.reply(
      `Scheduled ID ${schedule.id} for ${date} ${time} in #${channel.name}. Repeat: ${repeat}.`
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
          `ID ${item.id} — #${item.channelName} — ${item.displayDate} ${item.displayTime} — repeat: ${item.repeat} — ${item.message.slice(0, 80)}`
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

  if (interaction.commandName === "timezone") {
    const zone = interaction.options.getString("zone");
    serverTimezone = zone;

    await interaction.reply(`Timezone set to ${serverTimezone}.`);
  }
});

cron.schedule("* * * * *", async () => {
  const now = DateTime.now().setZone(serverTimezone);

  for (const item of schedules) {
    if (item.sent) continue;

    const minutesUntil = item.target.diff(now, "minutes").minutes;

    if (item.oneHourBefore && !item.reminderSent && minutesUntil <= 60 && minutesUntil > 59) {
      await sendScheduledMessage(item, "before");
      item.reminderSent = true;
    }

    if (minutesUntil <= 0 && minutesUntil > -1) {
      await sendScheduledMessage(item, "now");
      advanceRecurringSchedule(item);
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
      option.setName("date").setDescription("DD-MM-YYYY or YYYY/MM/DD").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("time").setDescription("HH:mm").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("message").setDescription("Message").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("repeat")
        .setDescription("Repeat schedule")
        .setRequired(false)
        .addChoices(
          { name: "none", value: "none" },
          { name: "daily", value: "daily" },
          { name: "weekly", value: "weekly" },
          { name: "monthly", value: "monthly" }
        )
    )
    .addBooleanOption((option) =>
      option.setName("one_hour_before").setDescription("Send reminder 1 hour before")
    )
    .addBooleanOption((option) =>
      option.setName("ping_everyone").setDescription("Ping @everyone")
    )
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Optional image attachment")
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

  new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Set timezone")
    .addStringOption((option) =>
      option.setName("zone").setDescription("Example: Europe/London").setRequired(true)
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
