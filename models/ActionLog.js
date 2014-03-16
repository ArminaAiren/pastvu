'use strict';

var mongoose = require('mongoose'),
	Schema = mongoose.Schema;

//Модель логирования действий пользователей
var ActionLogSchema = new Schema(
		{
			user: {type: Schema.Types.ObjectId, ref: 'User', required: true, index: true}, //Субъект действия
			stamp: {type: Date, 'default': Date.now, required: true}, //Время действия

			obj: {type: Schema.Types.ObjectId, required: true, index: true}, //Объект действия
			objtype: {type: Number, required: true, index: true}, //Тип объекта. 1 - пользователь, 2 - фото, 3 - комментарий

			type: {type: Number, required: true}, //Тип действия. 1 - создал, 8 - восстановил, 9 - удалил

			reason: {
				key: {type: Number}, //Номер причины из справочника
				desc: {type: String} //Ручное описание причины. Как основное, так и дополнительное в случае key
			},
			role: {type: Number}, //Реализуемая на момент действия роль пользователя, если она необходима для действия
			roleregion: {type: Number}, //Регион реализуемой роли

			addinfo: {type: Schema.Types.Mixed} //Дополнительная информация, структура которой зависит от объекта и действия
		},
		{
			strict: true,
			collection: 'actionlog'
		}
	);

ActionLogSchema.index({user: 1, stamp: -1});
ActionLogSchema.index({obj: 1, stamp: -1});

module.exports.makeModel = function (db) {
	db.model('ActionLog', ActionLogSchema);
};
