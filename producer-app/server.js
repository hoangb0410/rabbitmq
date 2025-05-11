require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const amqp = require("amqplib");

const app = express();
const port = process.env.PORT || 3000;
const rabbitmqUrl = process.env.RABBITMQ_URL;
const queueName = process.env.QUEUE_NAME;

app.use(bodyParser.json());

let channel, connection;

async function connectRabbitMQ() {
  try {
    connection = await amqp.connect(rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertQueue(queueName, { durable: true });
    console.log("Connected to RabbitMQ and queue asserted");

    connection.on("error", (err) => {
      console.error("RabbitMQ connection error:", err.message);
      // Có thể cần logic kết nối lại ở đây nếu lỗi không phải lúc khởi tạo
      // setTimeout(connectRabbitMQ, 5000); // Cân nhắc kỹ lưỡng việc retry vô hạn
    });
    connection.on("close", () => {
      console.warn("RabbitMQ connection closed. Attempting to reconnect...");
      // Reset channel và connection để connectRabbitMQ có thể thử tạo lại
      channel = null;
      connection = null;
      setTimeout(connectRabbitMQ, 5000); // Tự động kết nối lại
    });
  } catch (error) {
    console.error("Failed to connect to RabbitMQ during initial setup:", error);
    channel = null; // Đảm bảo channel là null nếu kết nối thất bại
    connection = null;
    setTimeout(connectRabbitMQ, 5000);
  }
}

connectRabbitMQ();

// Endpoint để gửi một tin nhắn
app.post("/submit-single-data", async (req, res) => {
  if (!channel) {
    return res
      .status(503) // Service Unavailable
      .send("RabbitMQ channel not available. Please try again later.");
  }

  const data = req.body;
  // Kiểm tra dữ liệu cơ bản, bạn có thể cần validation chi tiết hơn
  if (
    !data ||
    typeof data.name !== "string" ||
    typeof data.value === "undefined"
  ) {
    return res
      .status(400)
      .send('Invalid data. "name" (string) and "value" are required.');
  }

  const message = JSON.stringify(data);

  try {
    // Gửi tin nhắn đến queue
    // Sử dụng publish thay vì sendToQueue nếu bạn muốn dùng exchange (mặc định sendToQueue dùng default exchange)
    await channel.sendToQueue(queueName, Buffer.from(message), {
      persistent: true,
    });
    console.log(`[Producer] Sent single: ${message}`);
    res
      .status(202)
      .send({ message: "Data submitted for processing.", data: data });
  } catch (error) {
    console.error("Failed to send single message to RabbitMQ:", error);
    // Nếu lỗi là do channel/connection, có thể nó sẽ được xử lý bởi listener 'error' hoặc 'close'
    // Tuy nhiên, ở đây có thể trả về lỗi cụ thể cho client
    res.status(500).send("Error submitting data.");
  }
});

// Endpoint mới để gửi nhiều tin nhắn
app.post("/submit-bulk-data", async (req, res) => {
  if (!channel) {
    return res
      .status(503) // Service Unavailable
      .send("RabbitMQ channel not available. Please try again later.");
  }

  const dataArray = req.body; // Mong đợi một mảng các đối tượng

  if (!Array.isArray(dataArray) || dataArray.length === 0) {
    return res
      .status(400)
      .send("Invalid input. Expected a non-empty array of data objects.");
  }

  let successCount = 0;
  let failedCount = 0;
  const results = [];

  // Sử dụng Promise.allSettled để xử lý tất cả các lần gửi, ngay cả khi một số thất bại
  // Hoặc bạn có thể lặp tuần tự nếu thứ tự là cực kỳ quan trọng và muốn dừng nếu có lỗi
  for (const data of dataArray) {
    // Kiểm tra từng object trong mảng
    if (
      !data ||
      typeof data.name !== "string" ||
      typeof data.value === "undefined"
    ) {
      failedCount++;
      results.push({
        status: "failed",
        reason: "Invalid data object structure.",
        item: data,
      });
      console.warn(
        `[Producer] Skipped invalid data object: ${JSON.stringify(data)}`
      );
      continue; // Bỏ qua item không hợp lệ này
    }

    const message = JSON.stringify(data);
    try {
      // Gửi từng tin nhắn
      // Sử dụng await ở đây để đảm bảo thứ tự nếu cần, hoặc bỏ await nếu muốn gửi song song (cẩn thận với giới hạn của channel)
      // Tuy nhiên, sendToQueue là non-blocking nếu không có callback, nhưng với async/await,
      // chúng ta đợi operation này hoàn thành (hoặc ít nhất là được đưa vào buffer của client lib)
      await channel.sendToQueue(queueName, Buffer.from(message), {
        persistent: true,
      });
      console.log(`[Producer] Sent in bulk: ${message}`);
      successCount++;
      results.push({ status: "submitted", data: data });
    } catch (error) {
      failedCount++;
      results.push({ status: "failed", reason: error.message, item: data });
      console.error(
        `[Producer] Failed to send message in bulk: ${message}`,
        error
      );
      // Nếu một tin nhắn lỗi, bạn có thể quyết định dừng toàn bộ hoặc tiếp tục với các tin nhắn khác
      // Ở đây chúng ta tiếp tục
    }
  }

  if (failedCount > 0 && successCount === 0) {
    res.status(500).send({
      message: "All messages failed to submit.",
      successCount,
      failedCount,
      details: results,
    });
  } else if (failedCount > 0) {
    res.status(207).send({
      // Multi-Status
      message: "Some messages submitted, some failed.",
      successCount,
      failedCount,
      details: results,
    });
  } else {
    res.status(202).send({
      message: "All data submitted successfully for processing.",
      successCount,
      failedCount, // sẽ là 0
      submittedData: dataArray, // hoặc results
    });
  }
});

app.listen(port, () => {
  console.log(`Producer app listening at http://localhost:${port}`);
});

// Cải thiện việc đóng kết nối
async function gracefulShutdown() {
  console.log("Attempting graceful shutdown...");
  if (channel) {
    try {
      await channel.close();
      console.log("RabbitMQ channel closed.");
    } catch (err) {
      console.error("Error closing RabbitMQ channel:", err.message);
    }
  }
  if (connection) {
    try {
      await connection.close();
      console.log("RabbitMQ connection closed.");
    } catch (err) {
      console.error("Error closing RabbitMQ connection:", err.message);
    }
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown); // Ctrl+C
process.on("SIGTERM", gracefulShutdown); // Lệnh kill

// Xử lý lỗi không bắt được
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Cân nhắc việc shutdown ở đây, nhưng hãy cẩn thận vì có thể làm mất state
  // gracefulShutdown(); // Có thể gọi ở đây nhưng cần test kỹ
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Tương tự uncaughtException
  // gracefulShutdown();
});
