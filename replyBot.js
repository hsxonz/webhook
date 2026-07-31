const express = require('express');
const bodyParser = require('body-parser');
const axios = require("axios");


const app = express();
const PORT = 3011
const groupAvaiable = ["120363345556991447@g.us", "120363369044479086@g.us", "120363380851654492@g.us", "120363410405750508@g.us", "120363417401680122@g.us", "120363418161872250@g.us", "120363419436086062@g.us", "120363421380907896@g.us","120363419648387286@g.us"]
const keywords = ["want to buy", "want buy", "how much","What price"]
app.use(bodyParser.json());

app.get("/", (req, res) => {
    res.send("Webhook server is running");
});


const replyTo = async (groupId, message, replyTo, session) => {
    let data = JSON.stringify({
        "chatId": groupId,
        "reply_to": replyTo,
        "text": message,
        "linkPreview": true,
        "linkPreviewHighQuality": false,
        "session": session
    });

    let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'http://160.191.164.12:3000/api/sendText',
        headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json'
        },
        data: data
    };

    await axios.request(config)
        .then((response) => {
            console.log(JSON.stringify(response.data));
        })
        .catch((error) => {
            console.log(error);
        });

}

const checkMessage = (message) => {
    const lowerCaseMessage = message.toLowerCase();
    return keywords.some(keyword => lowerCaseMessage.includes(keyword));
}

app.post("/reply", async (req, res) => {
    const timestamp = new Date().toISOString();
    if (req.body.event == "message") {
        const session = req.body.session || "default";
        const groupId = req.body.payload.from;
        if (groupAvaiable.includes(groupId)) {
            const message = req.body.payload.body;
            if(message == "") return res.status(200).send("Message is empty");
            // console.log(`[${timestamp}] 📥 Received message event for group ${groupId}:`, req.body);
            if (!checkMessage(message)) {
                console.log(`[${timestamp}] ❌ Message does not contain keywords:`, message);
                return res.status(200).send("Message does not contain keywords");
            } else {
                const id_message = req.body.payload._data.Info.ID;
                let contactAuthorId = req.body.payload.participant;
                await replyTo(groupId, "Please check dm me sir", id_message, session);
                await replyTo(contactAuthorId, "Hello sir this is price", null, session);
                return res.status(200).send("Message processed");
            }
        }else{
            console.log(`[${timestamp}] ❌ Group ID ${groupId} is not in the list of available groups.`);
            return res.status(200).send("Group ID not available");
        }
    }
    console.log(`[${timestamp}] 📥 Received webhook event:`, req.body.event);
    return res.status(200).send("OK");
})

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// http://160.191.164.12:3011/reply