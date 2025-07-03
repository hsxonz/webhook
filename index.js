// webhook-server.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require("axios");
const moment = require('moment-timezone');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sasToken = "sv=2022-11-02&ss=bfqt&srt=o&sp=rwdlacupiytfx&se=2025-09-29T22:26:17Z&st=2024-09-22T14:26:17Z&spr=https&sig=n%2BUyZae6g%2B2HzsJa9dwiQWgmLYyBsIdeRWH3zUy4JrM%3D";
const blobUrl = "https://phoneinx.blob.core.windows.net";
const containerName = "hsxonzblod";
const fileExtension = "jpg";

const frontDoorUrl = "https://image-aqbrhxhdh2e8heaq.z03.azurefd.net";
const app = express();
const PORT = process.env.PORT || 3001;


let countMessage = 0;
let groupsSet = new Set();
app.use(bodyParser.json());

const getBase64Hash = (base64Data) => {
  const hashSum = crypto.createHash('sha256');
  hashSum.update(Buffer.from(base64Data, 'base64'));
  return hashSum.digest('hex');
};

const uploadImageToAzure = async (imageBase64) => {
  const blobServiceClient = new BlobServiceClient(`${blobUrl}?${sasToken}`);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  // Tính toán hash của hình ảnh Base64 (sử dụng SHA-256) và lấy tên file dựa trên hash
  const fileHash = getBase64Hash(imageBase64);
  const fileName = `${fileHash}.${fileExtension}`; // Tên file sẽ là hash của nội dung

  const blockBlobClient = containerClient.getBlockBlobClient(fileName);

  // Kiểm tra xem ảnh đã tồn tại hay chưa
  const exists = await blockBlobClient.exists();

  if (exists) {
    console.log(`File already exists.`);
    // Xây dựng URL từ Front Door hoặc từ Azure Blob trực tiếp
    return `${frontDoorUrl}/${containerName}/${fileName}`;
  }

  const fileBuffer = Buffer.from(imageBase64, 'base64');
  const contentType = `image/${fileExtension}`;

  await blockBlobClient.upload(fileBuffer, fileBuffer.length, {
    blobHTTPHeaders: {
      blobContentType: contentType,
    },
  });

  // Trả về URL truy cập thông qua Front Door hoặc trực tiếp từ Azure Blob
  return `${frontDoorUrl}/${containerName}/${fileName}`;
};

const getTime = () => {
  const currentUtcTime = moment.utc();
  const formattedUtcTime = currentUtcTime.format('YYYY-MM-DD HH:mm:ss.SSSSSS') + '+00:00';
  return formattedUtcTime;
}

const adDataServer = async (message, groupName, senderName, senderPhone, string_url) => {
  let data = JSON.stringify([{
    "id": "8281045",
    "message": message,
    "groupName": groupName,
    "senderName": senderName,
    "senderPhone": senderPhone,
    "time": getTime(),
    "image": string_url
  }]);
  let config = {
    method: 'put',
    maxBodyLength: Infinity,
    url: 'http://157.10.195.156:8815/search/v2/es/data/insert',
    headers: {
      'Content-Type': 'application/json'
    },
    data: data
  };

  return await axios.request(config)
    .then((response) => {
      console.log(JSON.stringify(response.data));
      return true;
    })
    .catch((error) => {
      console.log(error.toString());
      return false;
    });

}



const getGroupsInfo = async (group, session = "default") => {
  return await axios.get(`http://160.191.164.12:3000/api/${session}/groups/${group}`).then(res => {
    return {
      status: true,
      data: res.data
    }
  }).catch(err => {
    console.error(`Error fetching group info: ${err.message}`);
    return {
      status: false,
      data: null
    }
  });
}

const getContactInfo = async (contact, session = "default") => {
  return await axios.get(`http://160.191.164.12:3000/api/${session}/lids/${contact}`).then(res => {
    return {
      status: true,
      data: res.data
    }
  }).catch(err => {
    console.error(`Error fetching group info: ${err.message}`);
    return {
      status: false,
      data: null
    }
  });
}


app.post('/webhook', async (req, res) => {
  const timestamp = new Date().toISOString();
  if (req.body.event == "message") {
    countMessage++;
    console.log(`[${timestamp}] 📥 Received message event:`, countMessage);
    const session = req.body.session || "default";
    const groupId = req.body.payload.from;
    const body = req.body.payload.body;
    const contactAuthor = req.body.payload._data.Info.PushName;
    let groupName = ""
    let contactAuthorId = req.body.payload.participant;
    if (contactAuthorId.includes("lid")) {
      const newCheck = await getContactInfo(contactAuthorId,session);
      if (newCheck.status) contactAuthorId = newCheck.data.pn;
      console.log(newCheck);
    }
    const contactGroup = await getGroupsInfo(groupId,session);
    if (contactGroup.status) {
      groupName = contactGroup.data.Name;
    }
    let azureImageUrl = "";

    if (req.body.payload.hasMedia && req.body.payload.media?.url) {
      const mediaUrl = req.body.payload.media.url.replace("localhost:3000","160.191.164.12:3000");
      console.log(`[${timestamp}] 📷 Media URL:`, mediaUrl);
      try {
        // Tải ảnh từ media.url
        const imageResponse = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
        });

        const imageBase64 = Buffer.from(imageResponse.data, 'binary').toString('base64');

        // Upload lên Azure
        azureImageUrl = await uploadImageToAzure(imageBase64);
        console.log("✅ Uploaded image to Azure:", azureImageUrl);

      } catch (err) {
        console.error("❌ Failed to fetch or upload image:", err.message);
      }
    }
    console.log(azureImageUrl);
    if (groupName && groupId) {
      const groupObj = JSON.stringify({ id: groupId, name: groupName });
      groupsSet.add(groupObj);
    }
    await adDataServer(body, groupName, contactAuthor, contactAuthorId, azureImageUrl);

  } else
    console.log(`[${timestamp}] 📥 Received event:`, JSON.stringify(req.body, null, 2));

  res.status(200).send('OK');
});

app.get('/stats/messages', (req, res) => {
  res.json({ totalMessages: countMessage });
});

// API trả về danh sách các group đã được ghi nhận
app.get('/stats/groups', (req, res) => {
  const groupList = [...groupsSet].map(item => JSON.parse(item));
  res.json({ groups: groupList });
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] 🚀 Webhook server is running on port ${PORT}`);
});
