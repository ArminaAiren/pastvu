'use strict';

var Bluebird = require('bluebird');
var _ = require('lodash');
var UserObjectRel;
var User;
var Comment;
var CommentN;
var logger;

/**
 * Находим количество новых комментариев для списка объектов для пользователя
 * @param objIds Массив _id объектов
 * @param userId _id пользователя
 * @param type Тип объекта
 * @param [rels] Уже выбранные записи (например в отдаче подписок пользователя)
 */
var getRel = function (objIds, userId, type, rels) {
    if (!type) {
        type = 'photo';
    }

    if (rels && !Array.isArray(rels)) {
        rels = [rels];
    }

    var promise = rels ? Bluebird.resolve(rels) : UserObjectRel.findAsync(
        { obj: { $in: objIds }, user: userId, type: type },
        { _id: 0, obj: 1, view: 1, ccount_new: 1, sbscr_create: 1 },
        { lean: true }
    );

    return promise.then(function (rels) {
        var result = {};
        var res;
        var rel;

        for (var i = rels.length; i--;) {
            rel = rels[i];
            res = {
                view: rel.view,
                ccount_new: rel.ccount_new
            };

            if (rel.sbscr_create) {
                res.subscr = true;
            }

            result[rels[i].obj] = res;
        }

        return result;
    });
};

/**
 * Заполняет для каждого из массива переданных объектов кол-во новых комментариев - поле ccount_new
 * И флаг changed, если изменился ucdate с момента последнего просмотра объекта
 * Т.е. модифицирует исходные объекты
 * @param objs Массив объектов
 * @param userId _id пользователя
 * @param type Тип объекта
 */
var fillObjectByRels = function (objs, userId, type, rels) {
    var single = !Array.isArray(objs);
    var objIds = [];

    if (single) {
        objs = [objs];
    }

    // Составляем массив id объектов
    for (var i = objs.length; i--;) {
        objIds.push(objs[i]._id);
    }

    return getRel(objIds, userId, type, rels)
        .then(function (relHash) {
            var obj;
            var rel;

            for (var i = objs.length; i--;) {
                obj = objs[i];
                rel = relHash[obj._id];
                if (rel !== undefined) {
                    if (rel.view) {
                        obj.vdate = rel.view;

                        if (obj.ucdate && obj.ucdate > rel.view) {
                            obj.changed = true;
                        }
                    }
                    if (rel.subscr) {
                        obj.subscr = true;
                    }
                    if (rel.ccount_new) {
                        obj.ccount_new = rel.ccount_new;
                    }
                }
            }
            return single ? objs[0] : objs;
        });
};

/**
 * Записываем время последнего просмотра объекта пользователем
 * @param objId _id объекта
 * @param userId _id пользователя
 * @param [type] Тип объекта
 */
var setObjectView = Bluebird.method(function (objId, userId, type) {
    if (!type) {
        type = 'photo';
    }

    return UserObjectRel.findOneAndUpdateAsync(
        { obj: objId, user: userId, type: type },
        { $set: { view: new Date() } },
        { upsert: true, new: true, lean: true, fields: { _id: 0 } }
    );
});

/**
 * Записываем время последнего просмотра объекта пользователем
 * @param objId _id объекта
 * @param userId _id пользователя
 * @param [type] Тип объекта
 */
var setCommentView = Bluebird.method(function (objId, userId, type, stamp) {
    if (!type) {
        type = 'photo';
    }
    if (!stamp) {
        stamp = new Date();
    }

    var query = { obj: objId, user: userId, type: type };

    return UserObjectRel.findOneAsync(query, { _id: 0, obj: 0, user: 0, type: 0 }, { lean: true })
        .bind({})
        .then(function (relBeforeUpdate) {
            var update = { $set: { comments: stamp } };

            if (relBeforeUpdate) {
                // Сбрасываем кол-во новых комментариев
                update.$unset = { ccount_new: 1 };

                if (relBeforeUpdate.sbscr_noty) {
                    // Если было установлено время следующей отправки уведолмления, сбрасываем его
                    update.$unset.sbscr_noty = 1;
                    update.$set.sbscr_noty_change = stamp;
                }
            }

            this.relBeforeUpdate = relBeforeUpdate;

            return UserObjectRel.updateAsync(query, update, { upsert: true });
        })
        .spread(function () {
            return this.relBeforeUpdate;
        });
});

/**
 * При добавлении комментария увелививает счетчик новых у пользователей, прочитавших однажды комментрии объекта
 * @param objId _id объекта
 * @param userId _id пользователя
 * @param [type] Тип объекта
 */
var onCommentAdd = Bluebird.method(function (objId, userId, type) {
    if (!type) {
        type = 'photo';
    }
    var query = { obj: objId, comments: { $exists: true }, user: { $ne: userId }, type: type };

    return UserObjectRel.updateAsync(query, { $inc: { ccount_new: 1 } }, { multi: true })
        .bind({})
        .spread(function (count) {
            return count;
        });
});

/**
 * При удалении комментариев уменьшает счетчик новых у пользователей,
 * которые прочитали комментарии объекта до создания последнего из удаленных
 * @param objId _id объекта
 * @param comments комментарии
 * @param [type] Тип объекта
 */
var onCommentsRemove = Bluebird.method(function (objId, comments, type) {
    if (_.isEmpty(comments)) {
        return;
    }
    if (!type) {
        type = 'photo';
    }

    var lastCommentStamp = _.last(comments).stamp;

    // Для каждого пользователя, который последний раз просматривал коментарии объекта до даты последнего удаляемого комментария,
    // надо индивидуально посчитать сколько из удаляемых для него новые и не его собственные, и уменьшить на это кол-во
    return UserObjectRel.findAsync(
        { obj: objId, comments: { $lte: lastCommentStamp }, ccount_new: { $gt: 0 }, type: type },
        { _id: 1, user: 1, comments: 1, ccount_new: 1 },
        { lean: true }
    )
        .then(function (rels) {
            if (_.isEmpty(rels)) {
                return 0;
            }

            // Для каждого отношения ищем сколько удаленных комментариев были написаны после последнего посещения
            // и вычитаем их из кол-ва новых в этом отношении
            var updates = rels.reduce(function (result, rel) {
                var commentsView = rel.comments;
                var newDeltaCount = comments.reduce(function (result, comment) {
                    if (comment.stamp > commentsView && !rel.user.equals(comment.user)) {
                        result++;
                    }
                    return result;
                }, 0);

                if (newDeltaCount) {
                    if (newDeltaCount > rel.ccount_new) {
                        logger.warn('Try to decrease more new comments count due to comments removal, then they where calculated, objId: ' + objId + ', rel: ' + rel._id);
                        newDeltaCount = rel.ccount_new;
                    }

                    result.push(UserObjectRel.updateAsync(
                        // Обновляем конкретный rel, но на всякий случае указываем максимальное время просмотра комментариев,
                        // по которому мы считали, на случай, если пока мы считали пользователь опять посмотрел комментарии
                        { _id: rel._id, comments: { $lte: lastCommentStamp } },
                        { $inc: { ccount_new: -newDeltaCount } }
                    ));
                }

                return result;
            }, []);

            if (updates.length) {
                return Bluebird.all(updates)
                    .then(function (updateResults) {
                        return updateResults.reduce(function (result, updateResult) {
                            result += updateResult[0] || 0;
                            return result;
                        }, 0);
                    });
            }

            return 0;
        });
});

/**
 * При восстановлении комментариев увелививает счетчик новых у пользователей,
 * которые прочитали комментарии объекта до создания последнего из восстанавливаемых
 * @param objId _id объекта
 * @param comments комментарии
 * @param [type] Тип объекта
 */
var onCommentsRestore = Bluebird.method(function (objId, comments, type) {
    if (_.isEmpty(comments)) {
        return;
    }
    if (!type) {
        type = 'photo';
    }

    var lastCommentStamp = _.last(comments).stamp;

    // Для каждого пользователя, который последний раз просматривал коментарии объекта до даты последнего восстанавливаемого комментария,
    // надо индивидуально посчитать сколько из них для него новые и не его собственные, и увеличить на это кол-во
    return UserObjectRel.findAsync(
        { obj: objId, comments: { $lte: lastCommentStamp }, type: type },
        { _id: 1, user: 1, comments: 1 },
        { lean: true }
    )
        .then(function (rels) {
            if (_.isEmpty(rels)) {
                return 0;
            }

            // Для каждого отношения ищем сколько удаленных комментариев были написаны после последнего посещения
            // и вычитаем их из кол-ва новых в этом отношении
            var updates = rels.reduce(function (result, rel) {
                var commentsView = rel.comments;
                var newDeltaCount = comments.reduce(function (result, comment) {
                    if (comment.stamp > commentsView && !rel.user.equals(comment.user)) {
                        result++;
                    }
                    return result;
                }, 0);

                if (newDeltaCount) {
                    result.push(UserObjectRel.updateAsync(
                        // Обновляем конкретный rel, но на всякий случае указываем максимальное время просмотра комментариев,
                        // по которому мы считали, на случай, если пока мы считали пользователь опять посмотрел комментарии
                        { _id: rel._id, comments: { $lte: lastCommentStamp } },
                        { $inc: { ccount_new: newDeltaCount } }
                    ));
                }

                return result;
            }, []);

            if (updates.length) {
                return Bluebird.all(updates)
                    .then(function (updateResults) {
                        return updateResults.reduce(function (result, updateResult) {
                            result += updateResult[0] || 0;
                            return result;
                        }, 0);
                    });
            }

            return 0;
        });
});


/**
 * Находим количество новых комментариев для формирования письма уведомления пользователю
 * @param objs Массив _id объектов
 * @param relHash
 * @param userId _id пользователя
 * @param [type] Тип объекта
 */
function getNewCommentsBrief(objs, relHash, userId, type) {
    if (_.isEmpty(objs)) {
        return [];
    }

    var commentModel = type === 'news' ? CommentN : Comment;
    var objsCommentsIds = [];
    var promises = [];
    var commentFrom;
    var objId;
    var rel;
    var i;

    // По каждому объекту выбираем комментарии со времени последнего просмотра комментариев или подписки
    for (i = objs.length; i--;) {
        objId = objs[i]._id;
        rel = relHash[objId];
        commentFrom = rel && (rel.comments || rel.sbscr_noty_change || rel.sbscr_create);

        if (!commentFrom) {
            continue;
        }

        objsCommentsIds.push(objId);
        promises.push(
            commentModel.find(
                { obj: objId, del: null, stamp: { $gt: commentFrom }, user: { $ne: userId } },
                { _id: 0, obj: 1, user: 1, stamp: 1 },
                { lean: true, sort: { stamp: 1 } })
                .populate({ path: 'user', select: { _id: 0, login: 1, disp: 1 } })
                .execAsync()
        );
    }

    return Bluebird
        .all(promises)
        .then(function (objComments) {
            var briefsHash = objComments.reduce(function (result, comments, index) {
                var objId = objsCommentsIds[index];

                result[objId] = comments.reduce(function (brief, comment) {
                    if (comment.stamp >= relHash[objId].sbscr_noty_change) {
                        brief.newest++;
                        brief.users[comment.user.login] = comment.user.disp;
                    }
                    return brief;
                }, { unread: comments.length, newest: 0, users: {} });

                return result;
            }, {});

            // Присваиваем каждому объекту его brief
            return _.forEach(objs, function (obj) {
                obj.brief = briefsHash[obj._id];
            });
        });
}


module.exports.loadController = function (app, db, io) {
    logger = require('log4js').getLogger('userobjectrel.js');

    User = db.model('User');
    Comment = db.model('Comment');
    CommentN = db.model('CommentN');
    UserObjectRel = db.model('UserObjectRel');
};

module.exports.getViewCommentsRel = getRel;
module.exports.fillObjectByRels = fillObjectByRels;
module.exports.getNewCommentsBrief = getNewCommentsBrief;
module.exports.setObjectView = setObjectView;
module.exports.setCommentView = setCommentView;
module.exports.onCommentAdd = onCommentAdd;
module.exports.onCommentsRemove = onCommentsRemove;
module.exports.onCommentsRestore = onCommentsRestore;