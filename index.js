const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");

const cron = require("node-cron");
const { DateTime } = require("luxon");
const fs = require("fs");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const SCHEDULES_FILE = "./schedules.json";
const SETTINGS_FILE = "./settings.json";

let schedules = loadJson(SCHEDULES_FILE, []);
let settings = loadJson(SETTINGS_FILE, {
  timezone: "Europe/London",
});

let nextId =
  schedules.length > 0 ? Math.max(...schedules.map((s) => s.id)) + 1 : 1;

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

function normalizeTimezone(input) {
  if (!input) return settings.timezone;

  const value = input.trim().toLowerCase();

  const aliases = {
    london: "Europe/London",
    uk: "Europe/London",
    "gmt+1": "Europe/London",
    bst: "Europe/London",

    turkey: "Europe/Istanbul",
    istanbul: "Europe/Istanbul",
    "gmt+3": "Europe/Istanbul",

    edt: "America/New_York",
    est: "America/New_York",
    et: "America/New_York",
    "new york": "America/New_York",

    pdt: "America/Los_Angeles",
    pst: "America/Los_Angeles",
    pt: "America/Los_Angeles",
    "los angeles": "America/Los_Angeles",
  };

  return aliases[value] || input.trim();
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
    return null;
  }

  const [hour, minute] = cleanTime.split(":");

  const dt = DateTime.fromObject(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    },
    { zone: settings.timezone }
  );

  return dt.isValid ? dt : null;
}

function extractChannelIds(rawChannels, fallbackChannelId) {
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

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendScheduledMessage(schedule) {
  for (const channelId of schedule.channelIds) {
    const channel = await client.channels.fetch(channelId);
    const chunks = splitMessage(schedule.message);

    for (let i = 0; i < chunks.length; i++) {
      await channel.send({
        content: chunks[i],
        files: i === 0 && schedule.imageUrl ? [schedule.imageUrl] : [],
        allowedMentions: { parse: ["everyone", "roles"] },
      });
    }
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "timezone") {
      await interaction.deferReply({ ephemeral: true });

      const zoneInput = interaction.options.getString("zone");
      const zone = normalizeTimezone(zoneInput);

      const test = DateTime.now().setZone(zone);
      if (!test.isValid) {
        await interaction.editReply({
          content:
            "Invalid timezone. Use something like `Europe/London`, `GMT+1`, `EDT`, or `Europe/Istanbul`.",
        });
        return;
      }

      settings.timezone = zone;
      saveJson(SETTINGS_FILE, settings);

      await interaction.editReply({
        content: `Timezone set to ${settings.timezone}.`,
      });
    }

    if (interaction.commandName === "schedule") {
      await interaction.deferReply({ ephemeral: true });

      const date = interaction.options.getString("date");
      const time = interaction.options.getString("time");
      const message = interaction.options.getString("message");
      const rawChannels = interaction.options.getString("channel");
      const image = interaction.options.getAttachment("image");

      const target = parseDateTime(date, time);

      if (!target) {
        await interaction.editReply({
          content: "Invalid date/time. Use `21-05-2026` and `14:30`.",
        });
        return;
      }

      const channelIds = extractChannelIds(rawChannels, interaction.channelId);

      if (channelIds.length === 0) {
        await interaction.editReply({
          content:
            "No valid channels found. Leave channel empty or mention channels like `#chat #wins`.",
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
        date,
        time,
        timezone: settings.timezone,
        targetISO: target.toISO(),
        channelIds,
        channelNames,
        message,
        imageUrl: image ? image.url : null,
        sent: false,
      };

      schedules.push(schedule);
      saveJson(SCHEDULES_FILE, schedules);

      await interaction.editReply({
        content: `Scheduled ID ${schedule.id} for ${date} ${time} (${settings.timezone}) in ${channelNames
          .map((name) => `#${name}`)
          .join(", ")}.`,
      });
    }

    if (interaction.commandName === "list") {
      await interaction.deferReply({ ephemeral: true });

      const active = schedules.filter((s) => !s.sent);

      if (active.length === 0) {
        await interaction.editReply({
          content: "No active scheduled messages.",
        });
        return;
      }

      await interaction.editReply({
        content:
          "Active schedules:\n" +
          active
            .map(
              (s) =>
                `ID ${s.id} — ${s.date} ${s.time} (${s.timezone}) — ${s.channelNames
                  .map((name) => `#${name}`)
                  .join(", ")} — ${s.message.slice(0, 80)}`
            )
            .join("\n"),
      });
    }

    if (interaction.commandName === "cancel") {
      await interaction.deferReply({ ephemeral: true });

      const id = interaction.options.getInteger("id");
      const before = schedules.length;

      schedules = schedules.filter((s) => s.id !== id);
      saveJson(SCHEDULES_FILE, schedules);

      await interaction.editReply({
        content:
          schedules.length === before
            ? `No schedule found with ID ${id}.`
            : `Cancelled schedule ID ${id}.`,
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

cron.schedule("*/10 * * * * *", async () => {
  const now = DateTime.utc();
  let changed = false;

  for (const schedule of schedules) {
    if (schedule.sent) continue;

    const target = DateTime.fromISO(schedule.targetISO).toUTC();
    const secondsUntil = target.diff(now, "seconds").seconds;

    if (secondsUntil <= 0 && secondsUntil > -120) {
      await sendScheduledMessage(schedule);
      schedule.sent = true;
      changed = true;
    }
  }

  if (changed) {
    saveJson(SCHEDULES_FILE, schedules);
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
        .setDescription("Optional. Mention channels like #chat #wins")
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName("image")
        .setDescription("Optional image attachment")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("timezone")
    .setDescription("Set the timezone for future schedules")
    .addStringOption((option) =>
      option
        .setName("zone")
        .setDescription("Europe/London, GMT+1, EDT, Europe/Istanbul")
        .setRequired(true)
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
