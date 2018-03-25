'use strict';

var mongoose = require('mongoose'),
    natural = require('natural'),
    _ = require('underscore');

module.exports = function (schema, options) {
    var stemmer = natural[options.stemmer || 'PorterStemmer'],
        distance = natural[options.distance || 'LevenshteinDistance'],//'JaroWinklerDistance'],
        fields = options.fields,
        keywordsPath = options.keywordsPath || '_keywords',
        relevancePath = options.relevancePath || '_relevance';

    // init keywords field
    var schemaMixin = {};
    schemaMixin[keywordsPath] = [{
        keyword: String,
        weight: {type: Number, default: 1}
    }];
    schemaMixin[relevancePath] = Number;
    schema.add(schemaMixin);
    schema.path(keywordsPath).index(true);


    // search method
    schema.statics.search = function (query, fields, options, callback) {
        if (arguments.length === 2) {
            callback = fields;
            options = {};
        } else {
            if (arguments.length === 3) {
                callback = options;
                options = {};
            } else {
                options = options || {};
            }
        }

        var self = this;
        var tokens = _(stemmer.tokenizeAndStem(query)).unique(),
            conditions = options.conditions || {},
            outFields = {_id: 1},
            findOptions = _(options).pick('sort');

        conditions[keywordsPath + ".keyword"] = {$in: tokens};
        outFields[keywordsPath] = 1;


        mongoose.Model.find.call(this, conditions, outFields, findOptions,
            function (err, docs) {
                if (err) return callback(err);
                var totalCount = docs.length,
                    processMethod = options.sort ? 'map' : 'sortBy';

                // count relevance and sort results if sort option not defined
                docs = _(docs)[processMethod](function (doc) {
                    var relevance = processRelevance(tokens, doc.get(keywordsPath));
                    doc.set(relevancePath, relevance);
                    return processMethod === 'map' ? doc : -relevance;
                });

                // slice results and find full objects by ids
                if (options.limit || options.skip) {
                    options.skip = options.skip || 0;
                    options.limit = options.limit || (docs.length - options.skip);
                    docs = docs.slice(options.skip || 0, options.skip + options.limit);
                }

                var docsHash = _(docs).indexBy('_id'),
                    findConditions = _({
                        _id: {$in: _(docs).pluck('_id')}
                    }).extend(options.conditions);

                var cursor = mongoose.Model.find
                    .call(self, findConditions, fields, findOptions);

                // populate
                if (options.populate) {
                    options.populate.forEach(function (object) {
                        cursor.populate(object.path, object.fields);
                    });
                }

                cursor.exec(function (err, docs) {
                    if (err) return callback(err);

                    // sort result docs
                    callback(null, {
                        results: _(docs)[processMethod](function (doc) {
                            var relevance = docsHash[doc._id].get(relevancePath);
                            doc.set(relevancePath, relevance);
                            return processMethod === 'map' ? doc : -relevance;
                        }),
                        totalCount: totalCount
                    });
                });
            });

        function processRelevance(queryTokens, resultTokens) {
            var relevance = 0;

            queryTokens.forEach(function (token) {
                relevance += tokenRelevance(token, resultTokens);
            });
            return relevance;
        }

        function tokenRelevance(token, resultTokens) {
            var relevanceThreshold = 0.5,
                result = 0;

            resultTokens.forEach(function (rToken) {
                var relevance = distance(token, rToken.keyword);
                if (relevance > relevanceThreshold) {
                    result += rToken.weight * relevance;
                }
            });

            return result;
        }
    };

    // set keywords for all docs in db
    schema.statics.setKeywords = function (callback) {
        callback = _(callback).isFunction() ? callback : function () {
        };

        var skip = 1;
        var limit = 100

        mongoose.Model.count.call(this, (err, count) => {
                if (err) return callback(err)
                if (count < 1) return callback(null)

                if (limit > count) {
                    limit = count
                }

                var done = _.after(count, function () {
                    callback();
                });


                do {
                    mongoose.Model.find.call(this, {}, {}, {'skip': skip, 'limit': limit}, (err, docs) => {
                        if (err) return callback(err);

                        console.log([count, limit, skip, docs.length])
                        if (docs.length) {
                            docs.forEach(function (doc) {
                                doc.updateKeywords();

                                doc.save(function (err) {
                                    if (err) console.log('[mongoose search plugin err] ', err, err.stack);
                                    done();
                                });
                            });
                        } else {
                            callback();
                        }
                    });
                    skip += limit;
                } while (skip < count);
            }
        );
    };

    schema.methods.updateKeywords = function () {
        this.set(keywordsPath, this.processKeywords())
    };

    schema.methods.processKeywords = function () {
        var fieldTokens = [], result = []

        fields.forEach((field) => {
            var map = this.prepareToTokenize(field);
            _(stemmer.tokenizeAndStem(map)).unique().forEach((tk) => {
                var isFirst = true
                fieldTokens.forEach(fd => {
                    if (fd.keyword === tk) {
                        fd.weight += field.weight
                        isFirst = false
                    }
                })
                if (isFirst) {
                    fieldTokens.push({keyword: tk, weight: field.weight})
                }
            })


        })

        return fieldTokens
    };

    schema.methods.prepareToTokenize = function (field) {
        var val = this.get(field.name);

        if (_(val).isString()) {
            return val;
        }
        if (_(val).isArray()) {
            return val.join(' ');
        }

        return '';
    }

    schema.pre('save', function (next) {
        var self = this;

        var isChanged = this.isNew || fields.some(function (field) {
            return self.isModified(field.name);
        });

        if (isChanged) this.updateKeywords();
        next();
    });
};
