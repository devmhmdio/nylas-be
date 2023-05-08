const mongoose = require('mongoose');

const ReplySchema = new mongoose.Schema({
    body: {
        type: String,
        defaultValue: 'Body',
    },
    userEmail: {
        type: String,
        required: true,
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('Reply', ReplySchema);