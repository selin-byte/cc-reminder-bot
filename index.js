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

  if (value === "london") return "Europe/London";
  if (value === "uk") return "Europe/London";
  if (value === "turkey") return "Europe/Istanbul";
  if (value === "istanbul") return "Europe/Istanbul";

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

function convertDiscordTimestamps(message) {
  return message.replace(
    /\{\{time:(\d{2}[-/]\d{2}[-/]\d{4}|\d{4}[-/]\d{2}[-/]\d{2})\s+(\d{2}:\d{2})\}\}/g,
    (match, date, time) => {
      const dt = parseDateTime(date, time);

      if (!dt.isValid) return match;

      return `<t:${Math.floor(dt.toSeconds())}:F>`;
    }
  );
}

function extractChannelIds(rawChannels) {
  if (!rawChannels) return [];

  const ids = [];
  const matches = rawChannels.matchAll(/<#(\d+)>/g);

  for (const match of matches) {
    ids.push(match[1]);
  }

  return [...new Set(ids)];
}

async function sendScheduledMessage(item) {
  const message = convertDiscordTimestamps(item.message);

  for (const channelId of item.channelIds) {
    const channel = await client.channels.fetch(channelId);

    await channel.send({
      content: `${item.pingEveryone ? "@everyone\n" : ""}${message}`,
      files: item.imageUrl ? [item.imageUrl] : [],
      allowedMentions: { parse: ["everyone", "roles"] },
    });
  }
}

function advanceRecurringSchedule(item) {
  if (item.repeat === "daily") {
    item.target = item.target.plus({ days: 1 });
  } else if (item.repeat === "weekly") {
    item.target = item.target.plus({ weeks: 1 });
  } else if (item.repeat === "monthly") {
    item.target = item.target.plus({ months: 1 });
  } else {
    item.sent = true;
  }

  item.reminderSent = false;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "schedule") {
      await interaction.deferReply({ ephemeral: true });

      const date = interaction.options.getString("date");
      const time = interaction.options.getString("time");
      const message = interaction.options.getString("message");
      const rawChannels = interaction.options.getString("channel");
      const image = interaction.options.getAttachment("image");
      const repeat = interaction.options.getString("repeat") || "none";
      const oneHourBefore =
        interaction.options.getBoolean("one_hour_before") || false;
      const pingEveryone =
        interaction.options.getBoolean("ping_everyone") || false;

      const target = parseDateTime(date, time);

      if (!target.isValid) {
        await interaction.editReply({
          content: "Invalid date/time. Use `21-05-2026` and `14:30`.",
        });
        return;
      }

      const channelIdsFromInput = extractChannelIds(rawChannels);
      const channelIds =
        channelIdsFromInput.length > 0
          ? channelIdsFromInput
          : [interaction.channelId];

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
        repeat,
        oneHourBefore,
        pingEveryone,
        target,
        sent: false,
        reminderSent: false,
      };

      schedules.push(schedule);

      await interaction.editReply({
        content: `Scheduled ID ${schedule.id} for ${date} ${time} in ${channelNames
          .map((name) => `#${name}`)
          .join(", ")}. Repeat: ${repeat}.`,
      });
    }

    if (interaction.commandName === "list") {
      await interaction.deferReply({ ephemeral: true });

      const active = schedules.filter((item) => !item.sent);

      if (active.length === 0) {
        await interaction.editReply({
          content: "No active scheduled messages.",
        });
        return;
      }

      const list = active
        .map(
          (item) =>
            `ID ${item.id} — ${item.channelNames
              .map((name) => `#${name}`)
              .join(", ")} — ${item.displayDate} ${item.displayTime} — repeat: ${
              item.repeat
            } — ${item.message.slice(0, 80)}`
        )
        .join("\n");

      await interaction.editReply({
        content: "Active schedules:\n" + list,
      });
    }

    if (interaction.commandName === "cancel") {
      await interaction.deferReply({ ephemeral: true });

      const id = interaction.options.getInteger("id");
      const before = schedules.length;

      schedules = schedules.filter((item) => item.id !== id);

      await interaction.editReply({
        content:
          schedules.length === before
            ? `No schedule found with ID ${id}.`
            : `Cancelled schedule ID ${id}.`,
      });
    }

    if (interaction.commandName === "timezone") {
      await interaction.deferReply({ ephemeral: true });

      const zone = normalizeTimezone(interaction.options.getString("zone"));
      serverTimezone = zone;

      await interaction.editReply({
        content: `Timezone set to ${serverTimezone}.`,
      });
    }
  } catch (error) {
    console.error(error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: "Something went wrong. Check Railway logs.",
      });
    }
  }
});

cron.schedule("* * * * *", async () => {
  const now = DateTime.now().setZone(serverTimezone);

  for (const item of schedules) {
    if (item.sent) continue;

    const minutesUntil = item.target.diff(now, "minutes").minutes;

    if (
      item.oneHourBefore &&
      !item.reminderSent &&
      minutesUntil <= 60 &&
      minutesUntil > 59
    ) {
      await sendScheduledMessage(item);
      item.reminderSent = true;
    }

    if (minutesUntil <= 0 && minutesUntil > -1) {
      await sendScheduledMessage(item);
      advanceRecurringSchedule(item);
    }
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Schedule a message")
    .addStringOption((option) =>
      option
        .setName("date")
        .setDescription("DD-MM-YYYY or YYYY/MM/DD")
        .setRequired(true)
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
        .setDescription(
          "Optional. Mention one or more channels, e.g. #chat #wins"
        )
        .setRequired(false)
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
      option
        .setName("one_hour_before")
        .setDescription("Send reminder 1 hour before")
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("ping_everyone")
        .setDescription("Ping @everyone")
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("Optional image attachment")
        .setRequired(false)
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
      option
        .setName("zone")
        .setDescription("Example: Europe/London")
        .setRequired(true)
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
