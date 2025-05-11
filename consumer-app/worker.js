require("dotenv").config();
const amqp = require("amqplib");
const mysql = require("mysql2/promise"); // Sử dụng promise-based API

const rabbitmqUrl = process.env.RABBITMQ_URL;
const queueName = process.env.QUEUE_NAME;

const dbConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: Number(process.env.MYSQL_PORT),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let dbConnection;

async function connectMySQL() {
  try {
    dbConnection = await mysql.createConnection(dbConfig);
    console.log("Connected to MySQL");

    // Tạo bảng nếu chưa tồn tại (chỉ cho mục đích demo)
    await dbConnection.execute(`
            CREATE TABLE IF NOT EXISTS items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                value VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    console.log('Table "items" checked/created.');
  } catch (error) {
    console.error("Failed to connect or setup MySQL:", error);
    throw error; // Ném lỗi để retry ở connectRabbitMQAndConsume
  }
}

async function connectRabbitMQAndConsume() {
  try {
    await connectMySQL(); // Kết nối MySQL trước

    const connection = await amqp.connect(rabbitmqUrl);
    const channel = await connection.createChannel();
    await channel.assertQueue(queueName, { durable: true });

    console.log(
      `[Consumer] Waiting for messages in queue: ${queueName}. To exit press CTRL+C`
    );

    // prefetch(1) đảm bảo worker chỉ nhận 1 tin nhắn mỗi lần, xử lý xong mới nhận tin tiếp theo
    // Điều này quan trọng để phân phối công việc đều nếu có nhiều consumer
    channel.prefetch(1);

    channel.consume(
      queueName,
      async (msg) => {
        if (msg !== null) {
          const messageContent = msg.content.toString();
          console.log(`[Consumer] Received: ${messageContent}`);
          try {
            const data = JSON.parse(messageContent);

            // Lưu vào MySQL
            const [result] = await dbConnection.execute(
              "INSERT INTO items (name, value) VALUES (?, ?)",
              [data.name, data.value]
            );
            console.log(
              `[Consumer] Data saved to MySQL with ID: ${result.insertId}`
            );

            // Xác nhận đã xử lý tin nhắn thành công
            channel.ack(msg);
          } catch (parseError) {
            console.error(
              "[Consumer] Error parsing message or saving to DB:",
              parseError
            );
            // Từ chối tin nhắn và không đưa lại vào queue (hoặc có thể đưa lại tùy logic)
            // Nếu requeue = true, tin nhắn có thể bị lặp vô hạn nếu luôn lỗi
            channel.nack(msg, false, false);
          }
        }
      },
      {
        // noAck: false có nghĩa là chúng ta sẽ gửi ACK/NACK thủ công
        noAck: false,
      }
    );
  } catch (error) {
    console.error("Failed to connect to RabbitMQ or MySQL:", error);
    // Thử kết nối lại sau một khoảng thời gian
    console.log("Retrying connection in 5 seconds...");
    setTimeout(connectRabbitMQAndConsume, 5000);
  }
}

connectRabbitMQAndConsume();

// Xử lý đóng kết nối CSDL khi worker tắt
process.on("SIGINT", async () => {
  console.log("Gracefully shutting down consumer...");
  if (dbConnection) {
    try {
      await dbConnection.end();
      console.log("MySQL connection closed.");
    } catch (err) {
      console.error("Error closing MySQL connection:", err);
    }
  }
  process.exit(0);
});
