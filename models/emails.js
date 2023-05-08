const mongoose = require('mongoose');

const EmailSchema = new mongoose.Schema({
    subject: {
        type: String,
    },
    snippet: {
        type: String,
    },
    fromEmail: {
        type: String,
    },
    ownEmail: {
        type: String,
    },
    userId: {
        type: String,
    },
}, {
    timestamps: true,
});

EmailSchema.index({ userId: 1, subject: 1, snippet: 1 }, { unique: true });

module.exports = mongoose.model('Email', EmailSchema);