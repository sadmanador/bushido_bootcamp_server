require("dotenv").config();
const express = require("express");
const app = express();
const port = process.env.PORT || 5000;
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);
const jwt = require("jsonwebtoken");

//middleware
app.use(cors());
app.use(express.json());
const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res
      .status(401)
      .send({ error: true, message: "unauthorized access" });
  }

  const token = authorization.split(" ")[1];

  jwt.verify(token, process.env.TOKEN, (err, decoded) => {
    if (err) {
      return res
        .status(401)
        .send({ error: true, message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

const user = process.env.DB_USER;
const pass = process.env.DB_PASS;
const uri = `mongodb+srv://${user}:${pass}@cluster0.9mathic.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    client.connect();
    const classesCollection = client
      .db("bushido_bootcamp")
      .collection("classes");
    const studentsCollection = client
      .db("bushido_bootcamp")
      .collection("students");
    const takenCourseCollection = client
      .db("bushido_bootcamp")
      .collection("taken-course");
    const paymentCollection = client
      .db("bushido_bootcamp")
      .collection("payment-history");

    //getting token
    app.post("/jwt", (req, res) => {
      const students = req.body;
      const token = jwt.sign(students, process.env.TOKEN, { expiresIn: "24h" });
      res.send({ token });
    });

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const student = await studentsCollection.findOne(query);
      if (student?.role !== "admin") {
        return res
          .status(403)
          .send({ error: true, message: "Non-admin access forbidden" });
      }
      next();
    };
    const verifyInstructor = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const student = await studentsCollection.findOne(query);
      if (student?.role !== "instructor") {
        return res
          .status(403)
          .send({ error: true, message: "Non-instructor access forbidden" });
      }
      next();
    };

    //stripe intent
    app.post("/payment-intent", async (req, res) => {
      const { price } = req.body;
      const amount = parseFloat(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    //stripe payment
    app.post("/payments", verifyJWT, async (req, res) => {
      const payment = req.body;
      const insertResult = await paymentCollection.insertOne(payment);
      const options = { upsert: true };
      const changeEnrollStatus = await takenCourseCollection.updateMany(
        { _id: new ObjectId(req.body.takenCourse) },
        { $set: { enrolled: "enrolled" } },
        options
      );

      const courseId = req.body.courseId;
      const updateSeats = await classesCollection.updateMany(
        { _id: new ObjectId(courseId) },
        { $inc: { seats: -1, enrolled: +1 } },
        options
      );

      res.send({ insertResult, changeEnrollStatus, updateSeats });
    });

    //payment history api
    app.get("/payments", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const result = await paymentCollection
        .find({ email: email })
        .sort({ date: -1 })
        .toArray();
      res.send(result);
    });

    //classes
    app.get("/classes", async (req, res) => {
      const result = await classesCollection
        .find({ status: "approved" })
        .toArray();
      res.send(result);
    });

    //all classes for admin
    app.get("/classes/all", async (req, res) => {
      const result = await classesCollection
        .find({ status: "approved" })
        .toArray();
      res.send(result);
    });

    //top 6 classes base on most students
    app.get("/classes/top-six", async (req, res) => {
      const result = await classesCollection
        .find({ status: "approved" })
        .sort({ enrolled: -1 })
        .limit(6)
        .toArray();
      res.send(result);
    });

    //add a new user
    app.post("/students", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await studentsCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "Already A registered Student" });
      }
      const result = await studentsCollection.insertOne(user);
      res.send(result);
    });

    //api for admin secure all users
    app.get("/students", verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const result = await studentsCollection.find({}).toArray();
      res.send(result);
    });

    //secure api for admin to put in users
    app.put("/students/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const role = req.body;
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const query = { _id: new ObjectId(id) };
      const updatedData = {
        $set: {
          role: role.role,
        },
      };
      const options = { upsert: true };

      const result = await studentsCollection.updateOne(
        query,
        updatedData,
        options
      );
      res.send(result);
    });

    //add cart post
    app.post("/taken-courses", async (req, res) => {
      const item = req.body;
      const query = { courseId: item.courseId, email: item.email };
      const existingCourse = await takenCourseCollection.findOne(query);
      if (existingCourse) {
        return res.send({ message: "This course is already added" });
      }
      const result = await takenCourseCollection.insertOne(item);
      res.send(result);
    });

    //remove cart item
    app.delete("/taken-courses/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await takenCourseCollection.deleteOne(query);
      res.send(result);
    });

    //all card course
    app.get("/taken-courses", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const query = { email: email, enrolled: "none" };
      const result = await takenCourseCollection.find(query).toArray();
      res.send(result);
    });

    //all card course that are enrolled
    app.get("/taken-courses/enrolled", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const query = { email: email, enrolled: "enrolled" };
      const result = await takenCourseCollection.find(query).toArray();
      res.send(result);
    });
    //single taken course
    app.get("/taken-courses/single/:id", verifyJWT, async (req, res) => {
      const email = req.query.email;
      if (!email) {
        res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const id = req.params.id;
      const query = { email: email, _id: new ObjectId(id) };
      const result = await takenCourseCollection.findOne(query);
      res.send(result);
    });

    app.get("/students/admin/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      if (!email) {
        return res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const query = { role: "admin", email: email };
      const result = await studentsCollection.findOne(query);
      res.send({ admin: !result ? false : result.role === "admin" });
    });

    app.get("/students/instructor/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      if (!email) {
        return res.send([]);
      }
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res
          .status(403)
          .send({ error: true, message: "unauthorize access" });
      }
      const query = { role: "instructor", email: email };

      const result = await studentsCollection.findOne(query);
      res.send({ admin: !result ? false : result.role === "instructor" });
    });

    //posting classes
    app.post("/classes", verifyJWT, verifyInstructor, async (req, res) => {
      const newClass = req.body;
      const result = await classesCollection.insertOne(newClass);
      res.send(result);
    });

    // get instructor's class with email as a query
    app.get(
      "/classes/myClasses",
      verifyJWT,
      verifyInstructor,
      async (req, res) => {
        const email = req.query.email;
        if (!email) {
          res.send([]);
        }
        const decodedEmail = req.decoded.email;
        if (email !== decodedEmail) {
          return res
            .status(403)
            .send({ error: true, message: "unauthorize access" });
        }
        const query = { email: email };
        const result = await classesCollection.find(query).toArray();
        res.send(result);
      }
    );
    // get instructor's single class with email as a query
    app.get(
      "/classes/myClasses/:id",
      verifyJWT,
      verifyInstructor,
      async (req, res) => {
        const email = req.query.email;

        if (!email) {
          res.send([]);
        }
        const decodedEmail = req.decoded.email;
        if (email !== decodedEmail) {
          return res
            .status(403)
            .send({ error: true, message: "unauthorize access" });
        }
        const id = req.params.id;
        const query = { email: email, _id: new ObjectId(id) };
        const result = await classesCollection.findOne(query);
        res.send(result);
      }
    );
    //put for instructor
    app.put(
      "/classes/myClasses/:id",
      verifyJWT,
      verifyInstructor,
      async (req, res) => {
        const id = req.params.id;
        const email = req.query.email;
        if (!email) {
          res.send([]);
        }
        const decodedEmail = req.decoded.email;
        if (email !== decodedEmail) {
          return res
            .status(403)
            .send({ error: true, message: "unauthorize access" });
        }
        const data = req.body;
        const options = { upsert: true };
        const query = { email: email, _id: new ObjectId(id) };
        const updatedData = {
          $set: {
            name: data.name,
            image: data.image,
            price: data.price,
            seats: data.seats,
          },
        };
        const result = await classesCollection.updateOne(
          query,
          updatedData,
          options
        );
        res.send(result);
      }
    );
    //put for admin
    app.put(
      "/classes/manageClasses/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const email = req.query.email;
        if (!email) {
          res.send([]);
        }
        const decodedEmail = req.decoded.email;
        if (email !== decodedEmail) {
          return res
            .status(403)
            .send({ error: true, message: "unauthorize access" });
        }
        const data = req.body;
        const options = { upsert: true };
        const query = { _id: new ObjectId(id) };
        const updatedData = {
          $set: {
            status: data.status,
            feedback: data.feedback,
          },
        };
        const result = await classesCollection.updateOne(
          query,
          updatedData,
          options
        );
        res.send(result);
      }
    );

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Bushido_Bootcamp is running");
});

app.listen(port, () => {
  console.log(`listening port: 5000`);
});
