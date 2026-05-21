const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
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

function normalizeTimezone(zone) {
  const value = zone.trim().toLowerCase();

  if (value === "london" || value === "uk" || value === "gmt+1") return "Europe/London";
  if (value === "turkey" || value === "istanbul" || value === "gmt+3") return "Europe/Istanbul";
  if (value === "edt" || value === "est" || value === "et") return "America/New_York";

  return zone.trim();
}

function parseDateTime(date, time) {
  const cleanDate = date.trim();
  const cleanTime = time.trim().replace(/\s/g, "");

  let day, month, year;

  if (cleanDate.includes("-")) {
    [day, month, year] = cleanDate.split("-");
  } else if (cleanDate.includes("/")) {
    const parts = cleanDate.split("/");
    if (parts[0].length === 4) {
      [year, month, day] = parts;
    } else {
      [day, month, year] = parts;
    }
  } else {
    return { isValid: false };
  }

  const [hour, minute] = cleanTime.split(":");

  return DateTime.fromObject(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    },
    { zone: serverTimezone }
  );
}

function getChannelIds(rawChannels, fallbackChannelId) {
  if (!rawChannels || rawChannels.trim() === "") {
    return [fallbackChannelId];
  }

  const ids = [];
  const matches = rawChannels.matchAll(/<#(\d+)>/g);

  for (const match of matches) {
    ids.push(match[1]);
  }

  return [...new Set(ids)];
}

async function sendScheduledMessage(item) {
  for (const channelId of item.channelIds) {
    const channel = await client.channels.fetch(channelId);

    await channel.send({
      content: item.message,
      files: item.imageUrl ? [item.imageUrl] : [],
      allowedMentions: { parse: ["everyone", "roles"] },
    });
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "schedule") {
    const date = interaction.options.getString("date");
    const time = interaction.options.getString("time");
    const message = interaction.options.getString("message");
    const rawChannels = interaction.options.getString("channel");
    const image = interaction.options.getAttachment("image");

    const target = parseDateTime(date, time);

    if (!target.isValid) {
      await interaction.reply({
        content: "Invalid date/time. Use `21-05-2026` and `14:30`.",
        ephemeral: true,
      });
      return;
    }

    const channelIds = getChannelIds(rawChannels, interaction.channelId);

    if (channelIds.length === 0) {
      await interaction.reply({
        content: "No valid channel found. Leave channel empty or mention channels like `#chat #wins`.",
        ephemeral: true,
      });
      return;
    }

    const channelNames = [];

    for (const channelId of channelIds) {
      try {
        const channel = await client.channels.fetch(channelId);
        channelNames.push(channel?.name || channelId);
      } catch {
        channelNames.push(channelId);
      }
    }

    const schedule = {
      id: nextId++,
      channelIds,
      channelNames,
      displayDate: date,
      displayTime: time,
      message,
      imageUrl: image ? image.url : null,
      target,
      sent: false,
    };

    schedules.push(schedule);

    await interaction.reply({
      content: `Scheduled ID ${schedule.id} for ${date} ${time} (${serverTimezone}) in ${channelNames
        .map((name) => `#${name}`)
        .join(", ")}.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "list") {
    const active = schedules.filter((item) => !item.sent);

    if (active.length === 0) {
      await interaction.reply({
        content: "No active scheduled messages.",
        ephemeral: true,
      });
      return;
    }

    const list = active
      .map(
        (item) =>
          `ID ${item.id} — ${item.displayDate} ${item.displayTime} (${serverTimezone}) — ${item.channelNames
            .map((name) => `#${name}`)
            .join(", ")} — ${item.message.slice(0, 80)}`
      )
      .join("\n");

    await interaction.reply({
      content: "Active schedules:\n" + list,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "cancel") {
    const id = interaction.options.getInteger("id");
    const before = schedules.length;

    schedules = schedules.filter((item) => item.id !== id);

    await interaction.reply({
      content:
        schedules.length === before
          ? `No schedule found with ID ${id}.`
          : `Cancelled schedule ID ${id}.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "timezone") {
    const zone = normalizeTimezone(interaction.options.getString("zone"));
    const test = DateTime.now().setZone(zone);

    if (!test.isValid) {
      await interaction.reply({
        content: "Invalid timezone. Try `Europe/London`, `GMT+1`, `EDT`, or `Europe/Istanbul`.",
        ephemeral: true,
      });
      return;
    }

    serverTimezone = zone;

    await interaction.reply({
      content: `Timezone set to ${serverTimezone}.`,
      ephemeral: true,
    });
  }
});

cron.schedule("*/10 * * * * *", async () => {
  const now = DateTime.now().setZone(serverTimezone);

  for (const item of schedules) {
    if (item.sent) continue;

    const secondsUntil = item.target.diff(now, "seconds").seconds;

    if (secondsUntil <= 0) {
      await sendScheduledMessage(item);
      item.sent = true;
    }
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Schedule a message")
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
        .setName("channel")
        .setDescription("Optional. Mention channels like #chat #wins")
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Optional image").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Set timezone")
    .addStringOption((option) =>
      option.setName("zone").setDescription("Europe/London, GMT+1, EDT").setRequired(true)
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
